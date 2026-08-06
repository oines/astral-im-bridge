import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import {
  embeddingContentHash,
  embeddingDocumentText,
  type EmbeddingBackfillResult,
  type EmbeddingJob,
  type EmbeddingWrite,
} from "./embedding.js";
import { buildFtsIndexText, buildFtsMatchQuery } from "./message_fts.js";
import type {
  ConversationUnread,
  EmbeddingConfig,
  Platform,
  SourceType,
  StoredAttachment,
  StoredMessage,
  StoredMessageReplyPreview,
  StoredMessageRow,
  StorageConfig,
} from "./types.js";

const MESSAGES_FTS_INDEX_VERSION = "1";
const MESSAGES_FTS_META_KEY = "messages_fts_index_version";
const MESSAGE_EMBEDDING_PROJECTION_VERSION = "1";
const MESSAGE_EMBEDDING_META_KEY = "message_embeddings_index_version";
const MESSAGE_EMBEDDING_SCHEDULER_VERSION = "1";
const MESSAGE_EMBEDDING_SCHEDULER_META_KEY = "message_embeddings_scheduler_version";
const MESSAGE_EMBEDDING_BACKFILL_CURSOR_META_KEY = "message_embeddings_backfill_cursor";

export class MessageStore {
  private readonly db: DatabaseSync;
  private readonly embeddingConfig: EmbeddingConfig | null;

  constructor(
    private readonly config: StorageConfig,
    embeddingConfig?: EmbeddingConfig,
  ) {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    fs.mkdirSync(config.mediaDir, { recursive: true });
    this.embeddingConfig = embeddingConfig?.enabled ? embeddingConfig : null;
    this.db = new DatabaseSync(config.dbPath, {
      allowExtension: this.embeddingConfig !== null,
    });
    if (this.embeddingConfig) {
      sqliteVec.load(this.db);
      this.db.enableLoadExtension(false);
    }
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  getMetaValue(key: string): string | null {
    return this.metaValue(key);
  }

  setMetaValue(key: string, value: string): void {
    this.writeMetaValue(key, value);
  }

  saveMessage(message: StoredMessage): number {
    const insert = this.db.prepare(`
      INSERT INTO messages (
        platform, platform_message_id, source_type, target_id, group_id, group_name,
        user_id, nickname, group_card, role, time, text, raw_message,
        trigger, reply_to_message_id, raw_event_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, source_type, target_id, platform_message_id) DO UPDATE SET
        group_name = excluded.group_name,
        nickname = excluded.nickname,
        group_card = excluded.group_card,
        role = excluded.role,
        text = excluded.text,
        raw_message = excluded.raw_message,
        trigger = excluded.trigger,
        reply_to_message_id = excluded.reply_to_message_id,
        raw_event_json = excluded.raw_event_json
    `);
    insert.run(
      message.platform,
      message.platformMessageId,
      message.sourceType,
      message.targetId,
      message.groupId,
      message.groupName,
      message.userId,
      message.nickname,
      message.groupCard,
      message.role,
      message.time,
      message.text,
      message.rawMessage,
      message.trigger,
      message.replyToMessageId,
      JSON.stringify(message.rawEvent),
    );

    const row = this.db
      .prepare(
        "SELECT id FROM messages WHERE platform = ? AND source_type = ? AND target_id = ? AND platform_message_id = ?",
      )
      .get(message.platform, message.sourceType, message.targetId, message.platformMessageId) as { id: number };

    this.db.prepare("DELETE FROM attachments WHERE message_row_id = ?").run(row.id);
    const attachmentInsert = this.db.prepare(`
      INSERT INTO attachments (
        message_row_id, kind, file_id, name, url, path, mime_type, size, raw_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const attachment of message.attachments) {
      attachmentInsert.run(
        row.id,
        attachment.kind,
        attachment.fileId,
        attachment.name,
        attachment.url,
        attachment.path,
        attachment.mimeType,
        attachment.size,
        JSON.stringify(attachment.raw),
      );
    }
    this.upsertMessageFts(row.id, message);
    this.queueMessageEmbedding(row.id, message, 1);
    return row.id;
  }

  enqueueEmbeddingBackfill(limit: number): EmbeddingBackfillResult {
    if (!this.embeddingConfig) {
      return { queued: 0, scanned: 0, complete: true };
    }
    const boundedLimit = Math.min(1_000, Math.max(1, Math.trunc(limit)));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const cursor = Number(this.metaValue(MESSAGE_EMBEDDING_BACKFILL_CURSOR_META_KEY) ?? "0");
      if (!Number.isSafeInteger(cursor) || cursor <= 0) {
        this.db.exec("COMMIT");
        return { queued: 0, scanned: 0, complete: true };
      }

      const rows = this.db.prepare(`
        SELECT *
        FROM messages
        WHERE id < ?
        ORDER BY id DESC
        LIMIT ?
      `).all(cursor, boundedLimit) as unknown as StoredMessageRow[];
      if (rows.length === 0) {
        this.writeMetaValue(MESSAGE_EMBEDDING_BACKFILL_CURSOR_META_KEY, "0");
        this.db.exec("COMMIT");
        return { queued: 0, scanned: 0, complete: true };
      }

      const rowIds = rows.map((row) => row.id);
      const placeholders = rowIds.map(() => "?").join(", ");
      const indexedRows = this.db.prepare(`
        SELECT message_row_id
        FROM message_embedding_state
        WHERE message_row_id IN (${placeholders})
      `).all(...rowIds) as unknown as Array<{ message_row_id: number }>;
      const queuedRows = this.db.prepare(`
        SELECT message_row_id
        FROM message_embedding_jobs
        WHERE message_row_id IN (${placeholders})
      `).all(...rowIds) as unknown as Array<{ message_row_id: number }>;
      const covered = new Set([
        ...indexedRows.map((row) => row.message_row_id),
        ...queuedRows.map((row) => row.message_row_id),
      ]);

      let queued = 0;
      for (const row of rows) {
        if (!covered.has(row.id) && this.queueMessageEmbeddingFromRow(row, 0)) {
          queued += 1;
        }
      }

      const nextCursor = rows[rows.length - 1].id;
      const hasMore = !!this.db.prepare(
        "SELECT 1 FROM messages WHERE id < ? LIMIT 1",
      ).get(nextCursor);
      this.writeMetaValue(
        MESSAGE_EMBEDDING_BACKFILL_CURSOR_META_KEY,
        hasMore ? String(nextCursor) : "0",
      );
      this.db.exec("COMMIT");
      return { queued, scanned: rows.length, complete: !hasMore };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  pendingEmbeddingJobs(limit: number): EmbeddingJob[] {
    if (!this.embeddingConfig) {
      return [];
    }
    const boundedLimit = Math.max(1, Math.trunc(limit));
    const rows = this.db.prepare(`
      SELECT
        j.message_row_id,
        j.content_hash,
        m.platform,
        m.source_type,
        m.target_id,
        m.user_id,
        m.time,
        m.text,
        m.raw_message
      FROM message_embedding_jobs AS j
      JOIN messages AS m ON m.id = j.message_row_id
      WHERE j.next_attempt_at <= ?
      ORDER BY j.priority DESC, j.message_row_id DESC
      LIMIT ?
    `).all(nowUnix(), boundedLimit) as unknown as EmbeddingJobRow[];
    return rows.map((row) => ({
      messageRowId: row.message_row_id,
      contentHash: row.content_hash,
      text: embeddingDocumentText(row.text, row.raw_message),
      platform: row.platform,
      sourceType: row.source_type,
      targetId: row.target_id,
      userId: row.user_id,
      time: row.time,
    }));
  }

  completeEmbeddingJobs(writes: EmbeddingWrite[]): number {
    if (!this.embeddingConfig || writes.length === 0) {
      return 0;
    }
    let completed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare(`
        SELECT j.content_hash, m.text, m.raw_message
        FROM message_embedding_jobs AS j
        JOIN messages AS m ON m.id = j.message_row_id
        WHERE j.message_row_id = ?
      `);
      const removeVector = this.db.prepare(
        "DELETE FROM message_embeddings WHERE message_row_id = ?",
      );
      const insertVector = this.db.prepare(`
        INSERT INTO message_embeddings (
          message_row_id, embedding, platform, source_type, target_id, user_id, time
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const upsertState = this.db.prepare(`
        INSERT INTO message_embedding_state (message_row_id, content_hash, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(message_row_id) DO UPDATE SET
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at
      `);
      const removeJob = this.db.prepare(
        "DELETE FROM message_embedding_jobs WHERE message_row_id = ? AND content_hash = ?",
      );
      for (const write of writes) {
        const row = current.get(write.messageRowId) as CurrentEmbeddingJobRow | undefined;
        const currentHash = row
          ? embeddingContentHash(embeddingDocumentText(row.text, row.raw_message))
          : null;
        if (!row || row.content_hash !== write.contentHash || currentHash !== write.contentHash) {
          continue;
        }
        removeVector.run(write.messageRowId);
        insertVector.run(
          BigInt(write.messageRowId),
          write.embedding,
          write.platform,
          write.sourceType,
          write.targetId,
          write.userId,
          BigInt(write.time),
        );
        upsertState.run(write.messageRowId, write.contentHash, nowUnix());
        removeJob.run(write.messageRowId, write.contentHash);
        completed += 1;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return completed;
  }

  failEmbeddingJobs(jobs: EmbeddingJob[], error: string): void {
    if (!this.embeddingConfig) {
      return;
    }
    const select = this.db.prepare(
      "SELECT attempts FROM message_embedding_jobs WHERE message_row_id = ? AND content_hash = ?",
    );
    const update = this.db.prepare(`
      UPDATE message_embedding_jobs
      SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE message_row_id = ? AND content_hash = ?
    `);
    const now = nowUnix();
    for (const job of jobs) {
      const row = select.get(job.messageRowId, job.contentHash) as { attempts: number } | undefined;
      if (!row) {
        continue;
      }
      const delaySeconds = Math.min(300, 5 * (2 ** Math.min(row.attempts, 6)));
      update.run(
        now + delaySeconds,
        error.slice(0, 2_000),
        now,
        job.messageRowId,
        job.contentHash,
      );
    }
  }

  embeddingIndexStats(): { indexed: number; pending: number; failed: number } {
    if (!this.embeddingConfig) {
      return { indexed: 0, pending: 0, failed: 0 };
    }
    const indexed = this.db.prepare(
      "SELECT COUNT(*) AS count FROM message_embedding_state",
    ).get() as { count: number };
    const jobs = this.db.prepare(`
      SELECT COUNT(*) AS pending, COUNT(*) FILTER (WHERE attempts > 0) AS failed
      FROM message_embedding_jobs
    `).get() as { pending: number; failed: number };
    return { indexed: indexed.count, pending: jobs.pending, failed: jobs.failed };
  }

  recentMessages(
    platform: Platform,
    sourceType: SourceType,
    targetId: string,
    limit: number,
    beforeMessageId?: string,
  ): StoredMessage[] {
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    let rows: StoredMessageRow[];
    if (beforeMessageId) {
      const anchor = this.db
        .prepare(
          "SELECT time, id FROM messages WHERE platform = ? AND source_type = ? AND target_id = ? AND platform_message_id = ?",
        )
        .get(platform, sourceType, targetId, beforeMessageId) as { time: number; id: number } | undefined;
      if (!anchor) {
        return [];
      }
      rows = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE platform = ? AND source_type = ? AND target_id = ?
             AND (time < ? OR (time = ? AND id < ?))
           ORDER BY time DESC, id DESC
           LIMIT ?`,
        )
        .all(platform, sourceType, targetId, anchor.time, anchor.time, anchor.id, boundedLimit) as unknown as StoredMessageRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE platform = ? AND source_type = ? AND target_id = ?
           ORDER BY time DESC, id DESC
           LIMIT ?`,
        )
        .all(platform, sourceType, targetId, boundedLimit) as unknown as StoredMessageRow[];
    }
    return rows.reverse().map((row) => this.rowToMessage(row));
  }

  getMessage(
    messageId: string,
    platform?: Platform,
    sourceType?: SourceType,
    targetId?: string,
  ): StoredMessage | null {
    const row = platform && sourceType && targetId
      ? (this.db
          .prepare(
            "SELECT * FROM messages WHERE platform = ? AND source_type = ? AND target_id = ? AND platform_message_id = ?",
          )
          .get(platform, sourceType, targetId, messageId) as StoredMessageRow | undefined)
      : (this.db
          .prepare(
            platform
              ? "SELECT * FROM messages WHERE platform = ? AND platform_message_id = ? ORDER BY time DESC, id DESC LIMIT 1"
              : "SELECT * FROM messages WHERE platform_message_id = ? ORDER BY time DESC, id DESC LIMIT 1",
          )
          .get(...(platform ? [platform, messageId] : [messageId])) as StoredMessageRow | undefined);
    return row ? this.rowToMessage(row) : null;
  }

  searchMessages(
    platform: Platform,
    sourceType: SourceType,
    targetId: string,
    query: string,
    limit: number,
  ): StoredMessage[] {
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const matchQuery = buildFtsMatchQuery(query);
    if (!matchQuery) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT messages.*
         FROM messages_fts
         INNER JOIN messages ON messages.id = messages_fts.rowid
         WHERE messages.platform = ? AND messages.source_type = ? AND messages.target_id = ?
           AND messages_fts MATCH ?
         ORDER BY bm25(messages_fts), messages.time DESC, messages.id DESC
         LIMIT ?`,
      )
      .all(platform, sourceType, targetId, matchQuery, boundedLimit) as unknown as StoredMessageRow[];
    return rows.map((row) => this.rowToMessage(row));
  }

  getAttachment(id: number): StoredAttachment | null {
    const row = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as AttachmentRow | undefined;
    return row ? attachmentFromRow(row) : null;
  }

  getAttachmentsForMessage(messageId: string, platform?: Platform): StoredAttachment[] {
    const message = this.getMessage(messageId, platform);
    return message?.attachments ?? [];
  }

  updateAttachmentPath(id: number, filePath: string): void {
    this.db.prepare("UPDATE attachments SET path = ? WHERE id = ?").run(filePath, id);
  }

  claimUnreadForPrompt(
    platform: Platform,
    sourceType: SourceType,
    targetId: string,
    currentMessageRowId: number,
  ): ConversationUnread {
    const cursor = this.conversationCursor(platform, sourceType, targetId);
    const previousRowId = cursor?.last_seen_message_row_id ?? 0;
    const stats = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MIN(id) AS first_id, MAX(id) AS latest_id
         FROM messages
         WHERE platform = ? AND source_type = ? AND target_id = ? AND id > ? AND id <= ?`,
      )
      .get(platform, sourceType, targetId, previousRowId, currentMessageRowId) as unknown as UnreadStatsRow;

    this.markConversationPrompted(platform, sourceType, targetId, currentMessageRowId, stats);

    return {
      unreadCount: stats.count,
    };
  }

  unreadMessages(platform: Platform, sourceType: SourceType, targetId: string, limit: number): Record<string, unknown> {
    const cursor = this.conversationCursor(platform, sourceType, targetId);
    const unreadCount = cursor?.last_prompt_unread_count ?? 0;
    const firstRowId = cursor?.last_prompt_first_message_row_id ?? null;
    const latestRowId = cursor?.last_prompt_latest_message_row_id ?? null;
    if (!cursor || unreadCount <= 0 || firstRowId == null || latestRowId == null) {
      return {
        platform,
        target_type: sourceType,
        target_id: targetId,
        unread_count: 0,
        returned_count: 0,
        truncated: false,
        messages: [],
      };
    }

    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages
           WHERE platform = ? AND source_type = ? AND target_id = ?
             AND id >= ? AND id <= ?
           ORDER BY id DESC
           LIMIT ?
         )
         ORDER BY id ASC`,
      )
      .all(platform, sourceType, targetId, firstRowId, latestRowId, boundedLimit) as unknown as StoredMessageRow[];
    const messages = rows.map((row) => this.rowToMessage(row));

    return {
      platform,
      target_type: sourceType,
      target_id: targetId,
      unread_count: unreadCount,
      returned_count: messages.length,
      truncated: unreadCount > messages.length,
      messages,
    };
  }

  conversationState(platform: Platform, sourceType: SourceType, targetId: string): Record<string, unknown> {
    const count = this.db
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE platform = ? AND source_type = ? AND target_id = ?")
      .get(platform, sourceType, targetId) as { count: number };
    const last = this.db
      .prepare(
        "SELECT * FROM messages WHERE platform = ? AND source_type = ? AND target_id = ? ORDER BY time DESC, id DESC LIMIT 1",
      )
      .get(platform, sourceType, targetId) as StoredMessageRow | undefined;
    const cursor = this.conversationCursor(platform, sourceType, targetId);
    const lastSeenRowId = cursor?.last_seen_message_row_id ?? 0;
    const unread = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM messages
         WHERE platform = ? AND source_type = ? AND target_id = ? AND id > ?`,
      )
      .get(platform, sourceType, targetId, lastSeenRowId) as { count: number };
    return {
      platform,
      source_type: sourceType,
      target_id: targetId,
      stored_message_count: count.count,
      unread_since_last_prompt: unread.count,
      last_prompt_message_id: cursor?.last_seen_platform_message_id ?? null,
      last_prompt_unread_count: cursor?.last_prompt_unread_count ?? 0,
      latest_message: last ? this.rowToMessage(last) : null,
    };
  }

  recentStoredMessages(limit: number): StoredMessage[] {
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const rows = this.db
      .prepare("SELECT * FROM messages ORDER BY time DESC, id DESC LIMIT ?")
      .all(boundedLimit) as unknown as StoredMessageRow[];
    return rows.map((row) => this.rowToMessage(row));
  }

  conversationSummaries(limit: number): Array<Record<string, unknown>> {
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const rows = this.db
      .prepare(
        `SELECT latest.*, counts.message_count
         FROM messages AS latest
         INNER JOIN (
           SELECT platform, source_type, target_id, MAX(id) AS latest_id, COUNT(*) AS message_count
           FROM messages
           GROUP BY platform, source_type, target_id
         ) AS counts
           ON counts.latest_id = latest.id
         ORDER BY latest.time DESC, latest.id DESC
         LIMIT ?`,
      )
      .all(boundedLimit) as unknown as Array<StoredMessageRow & { message_count: number }>;
    return rows.map((row) => ({
      platform: row.platform,
      sourceType: row.source_type,
      targetId: row.target_id,
      groupName: row.group_name,
      messageCount: row.message_count,
      latestMessage: this.rowToMessage(row),
    }));
  }

  mediaPath(filename: string): string {
    return path.join(this.config.mediaDir, filename);
  }

  private rowToMessage(row: StoredMessageRow): StoredMessage {
    const attachments = this.db
      .prepare("SELECT * FROM attachments WHERE message_row_id = ? ORDER BY id ASC")
      .all(row.id) as unknown as AttachmentRow[];
    return {
      id: row.id,
      platform: row.platform,
      platformMessageId: row.platform_message_id,
      sourceType: row.source_type,
      targetId: row.target_id,
      groupId: row.group_id,
      groupName: row.group_name,
      userId: row.user_id,
      nickname: row.nickname,
      groupCard: row.group_card,
      role: row.role,
      time: row.time,
      text: row.text,
      rawMessage: row.raw_message,
      trigger: row.trigger,
      replyToMessageId: row.reply_to_message_id,
      replyToMessage: this.replyPreview(row),
      rawEvent: JSON.parse(row.raw_event_json),
      attachments: attachments.map(attachmentFromRow),
    };
  }

  private replyPreview(row: StoredMessageRow): StoredMessageReplyPreview | null {
    if (!row.reply_to_message_id) {
      return null;
    }
    const reply = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE platform = ? AND source_type = ? AND target_id = ? AND platform_message_id = ?
         ORDER BY time DESC, id DESC
         LIMIT 1`,
      )
      .get(row.platform, row.source_type, row.target_id, row.reply_to_message_id) as StoredMessageRow | undefined;
    if (!reply) {
      return null;
    }
    return {
      id: reply.id,
      platformMessageId: reply.platform_message_id,
      sourceType: reply.source_type,
      targetId: reply.target_id,
      userId: reply.user_id,
      nickname: reply.nickname,
      groupCard: reply.group_card,
      role: reply.role,
      time: reply.time,
      text: reply.text,
      rawMessage: reply.raw_message,
      trigger: reply.trigger,
    };
  }

  private conversationCursor(platform: Platform, sourceType: SourceType, targetId: string): ConversationCursorRow | null {
    const row = this.db
      .prepare("SELECT * FROM conversation_cursors WHERE platform = ? AND source_type = ? AND target_id = ?")
      .get(platform, sourceType, targetId) as ConversationCursorRow | undefined;
    return row ?? null;
  }

  private platformMessageIdByRowId(rowId: number): string | null {
    const row = this.db
      .prepare("SELECT platform_message_id FROM messages WHERE id = ?")
      .get(rowId) as { platform_message_id: string } | undefined;
    return row?.platform_message_id ?? null;
  }

  private markConversationPrompted(
    platform: Platform,
    sourceType: SourceType,
    targetId: string,
    messageRowId: number,
    unreadStats: UnreadStatsRow,
  ): void {
    const messageId = this.platformMessageIdByRowId(messageRowId);
    if (!messageId) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO conversation_cursors (
           platform, source_type, target_id, last_seen_message_row_id, last_seen_platform_message_id,
           last_prompt_first_message_row_id, last_prompt_latest_message_row_id, last_prompt_unread_count,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(platform, source_type, target_id) DO UPDATE SET
           last_seen_message_row_id = excluded.last_seen_message_row_id,
           last_seen_platform_message_id = excluded.last_seen_platform_message_id,
           last_prompt_first_message_row_id = excluded.last_prompt_first_message_row_id,
           last_prompt_latest_message_row_id = excluded.last_prompt_latest_message_row_id,
           last_prompt_unread_count = excluded.last_prompt_unread_count,
           updated_at = excluded.updated_at
         WHERE excluded.last_seen_message_row_id > conversation_cursors.last_seen_message_row_id`,
      )
      .run(
        platform,
        sourceType,
        targetId,
        messageRowId,
        messageId,
        unreadStats.first_id,
        unreadStats.latest_id,
        unreadStats.count,
        Math.floor(Date.now() / 1000),
      );
  }

  private migrate(): void {
    this.rebuildLegacyPlatformTables();
    this.createMessageTables();
    this.ensureConversationCursorColumns();
    this.ensureMessageFtsIndex();
    this.ensureMessageEmbeddingIndex();

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_time
        ON messages(platform, source_type, target_id, time, id);

      CREATE INDEX IF NOT EXISTS idx_attachments_message
        ON attachments(message_row_id);
    `);

    this.db.exec(`
      INSERT OR IGNORE INTO conversation_cursors (
        platform, source_type, target_id, last_seen_message_row_id, last_seen_platform_message_id,
        last_prompt_first_message_row_id, last_prompt_latest_message_row_id, last_prompt_unread_count,
        updated_at
      )
      SELECT latest.platform, latest.source_type, latest.target_id, latest.id, latest.platform_message_id,
        NULL, NULL, 0, unixepoch()
      FROM messages AS latest
      INNER JOIN (
        SELECT platform, source_type, target_id, MAX(id) AS id
        FROM messages
        GROUP BY platform, source_type, target_id
      ) AS newest
        ON newest.platform = latest.platform
       AND newest.source_type = latest.source_type
       AND newest.target_id = latest.target_id
       AND newest.id = latest.id;
    `);
  }

  private createMessageTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL DEFAULT 'qq',
        platform_message_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        group_id TEXT,
        group_name TEXT,
        user_id TEXT NOT NULL,
        nickname TEXT,
        group_card TEXT,
        role TEXT,
        time INTEGER NOT NULL,
        text TEXT NOT NULL,
        raw_message TEXT NOT NULL,
        trigger TEXT NOT NULL,
        reply_to_message_id TEXT,
        raw_event_json TEXT NOT NULL,
        UNIQUE(platform, source_type, target_id, platform_message_id)
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_row_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        file_id TEXT,
        name TEXT,
        url TEXT,
        path TEXT,
        mime_type TEXT,
        size INTEGER,
        raw_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_cursors (
        platform TEXT NOT NULL DEFAULT 'qq',
        source_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        last_seen_message_row_id INTEGER NOT NULL,
        last_seen_platform_message_id TEXT NOT NULL,
        last_prompt_first_message_row_id INTEGER,
        last_prompt_latest_message_row_id INTEGER,
        last_prompt_unread_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(platform, source_type, target_id)
      );

      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private createMessageFtsTable(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        raw_message,
        sender,
        conversation,
        tokenize = 'unicode61'
      );
    `);
  }

  private ensureMessageEmbeddingIndex(): void {
    if (!this.embeddingConfig) {
      return;
    }
    const hadStateTable = this.tableExists("message_embedding_state");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_embedding_jobs (
        message_row_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS message_embedding_state (
        message_row_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        content_hash TEXT,
        updated_at INTEGER NOT NULL
      );

      DROP INDEX IF EXISTS idx_message_embedding_jobs_ready;
      CREATE INDEX IF NOT EXISTS idx_message_embedding_jobs_schedule
        ON message_embedding_jobs(priority DESC, message_row_id DESC, next_attempt_at);
    `);

    const signature = [
      MESSAGE_EMBEDDING_PROJECTION_VERSION,
      this.embeddingConfig.model,
      this.embeddingConfig.dimensions,
    ].join(":");
    const hasTable = this.tableExists("message_embeddings");
    const resetIndex = !hasTable || this.metaValue(MESSAGE_EMBEDDING_META_KEY) !== signature;
    if (hasTable && resetIndex) {
      this.db.exec("DROP TABLE message_embeddings");
    }
    if (resetIndex) {
      this.db.exec(`
        DELETE FROM message_embedding_jobs;
        DELETE FROM message_embedding_state;
      `);
    }
    if (!this.tableExists("message_embeddings")) {
      const dimensions = this.embeddingConfig.dimensions;
      this.db.exec(`
        CREATE VIRTUAL TABLE message_embeddings USING vec0(
          message_row_id INTEGER PRIMARY KEY,
          embedding float[${dimensions}] distance_metric=cosine,
          platform TEXT,
          source_type TEXT,
          target_id TEXT,
          user_id TEXT,
          time INTEGER
        );
      `);
    }

    const schedulerNeedsMigration =
      !hadStateTable
      || this.metaValue(MESSAGE_EMBEDDING_SCHEDULER_META_KEY) !== MESSAGE_EMBEDDING_SCHEDULER_VERSION;
    if (!resetIndex && schedulerNeedsMigration) {
      this.db.exec(`
        INSERT OR IGNORE INTO message_embedding_state (message_row_id, content_hash, updated_at)
        SELECT CAST(message_row_id AS INTEGER), NULL, unixepoch()
        FROM message_embeddings;
      `);
    }

    if (
      resetIndex
      || schedulerNeedsMigration
      || this.metaValue(MESSAGE_EMBEDDING_BACKFILL_CURSOR_META_KEY) === null
    ) {
      this.resetEmbeddingBackfillCursor();
    }
    this.writeMetaValue(MESSAGE_EMBEDDING_META_KEY, signature);
    this.writeMetaValue(
      MESSAGE_EMBEDDING_SCHEDULER_META_KEY,
      MESSAGE_EMBEDDING_SCHEDULER_VERSION,
    );
  }

  private resetEmbeddingBackfillCursor(): void {
    const row = this.db.prepare("SELECT MAX(id) AS max_id FROM messages").get() as {
      max_id: number | null;
    };
    const cursor = row.max_id === null ? 0 : row.max_id + 1;
    this.writeMetaValue(MESSAGE_EMBEDDING_BACKFILL_CURSOR_META_KEY, String(cursor));
  }

  private rebuildLegacyPlatformTables(): void {
    const messageColumns = this.tableColumns("messages");
    if (messageColumns.size > 0 && !messageColumns.has("platform")) {
      const hasAttachments = this.tableColumns("attachments").size > 0;
      this.db.exec("PRAGMA foreign_keys = OFF");
      try {
        this.db.exec("ALTER TABLE messages RENAME TO messages_legacy_platform");
        if (hasAttachments) {
          this.db.exec("ALTER TABLE attachments RENAME TO attachments_legacy_platform");
        }
        this.createMessageTables();
        this.db.exec(`
          INSERT INTO messages (
            id, platform, platform_message_id, source_type, target_id, group_id, group_name,
            user_id, nickname, group_card, role, time, text, raw_message,
            trigger, reply_to_message_id, raw_event_json
          )
          SELECT
            id, 'qq', platform_message_id, source_type, target_id, group_id, group_name,
            user_id, nickname, group_card, role, time, text, raw_message,
            trigger, reply_to_message_id, raw_event_json
          FROM messages_legacy_platform;
        `);
        if (hasAttachments) {
          this.db.exec(`
            INSERT INTO attachments (
              id, message_row_id, kind, file_id, name, url, path, mime_type, size, raw_json
            )
            SELECT id, message_row_id, kind, file_id, name, url, path, mime_type, size, raw_json
            FROM attachments_legacy_platform;
          `);
          this.db.exec("DROP TABLE attachments_legacy_platform");
        }
        this.db.exec("DROP TABLE messages_legacy_platform");
      } finally {
        this.db.exec("PRAGMA foreign_keys = ON");
      }
    }

    const cursorColumns = this.tableColumns("conversation_cursors");
    if (cursorColumns.size > 0 && !cursorColumns.has("platform")) {
      this.db.exec("ALTER TABLE conversation_cursors RENAME TO conversation_cursors_legacy_platform");
      this.createMessageTables();
      this.ensureConversationCursorColumnsFor("conversation_cursors_legacy_platform");
      this.db.exec(`
        INSERT INTO conversation_cursors (
          platform, source_type, target_id, last_seen_message_row_id, last_seen_platform_message_id,
          last_prompt_first_message_row_id, last_prompt_latest_message_row_id, last_prompt_unread_count,
          updated_at
        )
        SELECT
          'qq', source_type, target_id, last_seen_message_row_id, last_seen_platform_message_id,
          last_prompt_first_message_row_id, last_prompt_latest_message_row_id, last_prompt_unread_count,
          updated_at
        FROM conversation_cursors_legacy_platform;
      `);
      this.db.exec("DROP TABLE conversation_cursors_legacy_platform");
    }
  }

  private ensureConversationCursorColumns(): void {
    this.ensureConversationCursorColumnsFor("conversation_cursors");
  }

  private ensureConversationCursorColumnsFor(tableName: string): void {
    const rows = this.db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as unknown as Array<{ name: string }>;
    const columns = new Set(rows.map((row) => row.name));
    if (!columns.has("last_prompt_first_message_row_id")) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN last_prompt_first_message_row_id INTEGER`);
    }
    if (!columns.has("last_prompt_latest_message_row_id")) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN last_prompt_latest_message_row_id INTEGER`);
    }
    if (!columns.has("last_prompt_unread_count")) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN last_prompt_unread_count INTEGER NOT NULL DEFAULT 0`);
    }
  }

  private tableColumns(tableName: string): Set<string> {
    const rows = this.db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as unknown as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  }

  private tableExists(tableName: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1")
      .get(tableName);
    return !!row;
  }

  private metaValue(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM store_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private writeMetaValue(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  private ensureMessageFtsIndex(): void {
    const hasFts = this.tableExists("messages_fts");
    if (!hasFts || this.metaValue(MESSAGES_FTS_META_KEY) !== MESSAGES_FTS_INDEX_VERSION) {
      if (hasFts) {
        this.db.exec("DROP TABLE messages_fts");
      }
      this.createMessageFtsTable();
      this.rebuildMessageFtsIndex();
      this.writeMetaValue(MESSAGES_FTS_META_KEY, MESSAGES_FTS_INDEX_VERSION);
      return;
    }
    this.createMessageFtsTable();
  }

  private rebuildMessageFtsIndex(): void {
    this.db.exec("DELETE FROM messages_fts");
    const rows = this.db.prepare("SELECT * FROM messages ORDER BY id ASC").all() as unknown as StoredMessageRow[];
    for (const row of rows) {
      this.upsertMessageFtsFromRow(row);
    }
  }

  private upsertMessageFts(rowId: number, message: StoredMessage): void {
    this.writeMessageFts(rowId, {
      platform: message.platform,
      sourceType: message.sourceType,
      targetId: message.targetId,
      groupId: message.groupId,
      groupName: message.groupName,
      userId: message.userId,
      nickname: message.nickname,
      groupCard: message.groupCard,
      role: message.role,
      text: message.text,
      rawMessage: message.rawMessage,
    });
  }

  private upsertMessageFtsFromRow(row: StoredMessageRow): void {
    this.writeMessageFts(row.id, {
      platform: row.platform,
      sourceType: row.source_type,
      targetId: row.target_id,
      groupId: row.group_id,
      groupName: row.group_name,
      userId: row.user_id,
      nickname: row.nickname,
      groupCard: row.group_card,
      role: row.role,
      text: row.text,
      rawMessage: row.raw_message,
    });
  }

  private writeMessageFts(rowId: number, message: MessageFtsSource): void {
    this.db.prepare("DELETE FROM messages_fts WHERE rowid = ?").run(rowId);
    this.db.prepare(`
      INSERT INTO messages_fts (rowid, text, raw_message, sender, conversation)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      rowId,
      buildFtsIndexText(message.text),
      buildFtsIndexText(message.rawMessage),
      buildFtsIndexText(message.userId, message.nickname, message.groupCard, message.role),
      buildFtsIndexText(
        message.platform,
        message.sourceType,
        message.targetId,
        message.groupId,
        message.groupName,
      ),
    );
  }

  private queueMessageEmbedding(rowId: number, message: StoredMessage, priority: number): boolean {
    if (!this.embeddingConfig) {
      return false;
    }
    const text = embeddingDocumentText(message.text, message.rawMessage);
    return this.writeEmbeddingJob(rowId, text, priority);
  }

  private queueMessageEmbeddingFromRow(row: StoredMessageRow, priority: number): boolean {
    const text = embeddingDocumentText(row.text, row.raw_message);
    return this.writeEmbeddingJob(row.id, text, priority);
  }

  private writeEmbeddingJob(rowId: number, text: string, priority: number): boolean {
    if (!this.embeddingConfig) {
      return false;
    }
    this.db.prepare("DELETE FROM message_embedding_state WHERE message_row_id = ?").run(rowId);
    this.db.prepare("DELETE FROM message_embeddings WHERE message_row_id = ?").run(rowId);
    if (!text) {
      this.db.prepare("DELETE FROM message_embedding_jobs WHERE message_row_id = ?").run(rowId);
      return false;
    }
    this.db.prepare(`
      INSERT INTO message_embedding_jobs (
        message_row_id, content_hash, priority, attempts, next_attempt_at, last_error, updated_at
      ) VALUES (?, ?, ?, 0, 0, NULL, ?)
      ON CONFLICT(message_row_id) DO UPDATE SET
        content_hash = excluded.content_hash,
        priority = MAX(message_embedding_jobs.priority, excluded.priority),
        attempts = CASE
          WHEN message_embedding_jobs.content_hash = excluded.content_hash
            THEN message_embedding_jobs.attempts
          ELSE 0
        END,
        next_attempt_at = CASE
          WHEN message_embedding_jobs.content_hash = excluded.content_hash
            THEN message_embedding_jobs.next_attempt_at
          ELSE 0
        END,
        last_error = CASE
          WHEN message_embedding_jobs.content_hash = excluded.content_hash
            THEN message_embedding_jobs.last_error
          ELSE NULL
        END,
        updated_at = excluded.updated_at
    `).run(rowId, embeddingContentHash(text), priority, nowUnix());
    return true;
  }
}

interface MessageFtsSource {
  platform: Platform;
  sourceType: SourceType;
  targetId: string;
  groupId: string | null;
  groupName: string | null;
  userId: string;
  nickname: string | null;
  groupCard: string | null;
  role: string | null;
  text: string;
  rawMessage: string;
}

interface ConversationCursorRow {
  platform: Platform;
  source_type: SourceType;
  target_id: string;
  last_seen_message_row_id: number;
  last_seen_platform_message_id: string;
  last_prompt_first_message_row_id: number | null;
  last_prompt_latest_message_row_id: number | null;
  last_prompt_unread_count: number;
  updated_at: number;
}

interface UnreadStatsRow {
  count: number;
  first_id: number | null;
  latest_id: number | null;
}

interface AttachmentRow {
  id: number;
  kind: string;
  file_id: string | null;
  name: string | null;
  url: string | null;
  path: string | null;
  mime_type: string | null;
  size: number | null;
  raw_json: string;
}

interface EmbeddingJobRow {
  message_row_id: number;
  content_hash: string;
  platform: string;
  source_type: string;
  target_id: string;
  user_id: string;
  time: number;
  text: string;
  raw_message: string;
}

interface CurrentEmbeddingJobRow {
  content_hash: string;
  text: string;
  raw_message: string;
}

function attachmentFromRow(row: AttachmentRow): StoredAttachment {
  return {
    id: row.id,
    kind: row.kind,
    fileId: row.file_id,
    name: row.name,
    url: row.url,
    path: row.path,
    mimeType: row.mime_type,
    size: row.size,
    raw: JSON.parse(row.raw_json),
  };
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1_000);
}
