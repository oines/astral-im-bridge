import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ConversationUnread,
  SourceType,
  StoredAttachment,
  StoredMessage,
  StoredMessageRow,
  StorageConfig,
} from "./types.js";

export class MessageStore {
  private readonly db: DatabaseSync;

  constructor(private readonly config: StorageConfig) {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    fs.mkdirSync(config.mediaDir, { recursive: true });
    this.db = new DatabaseSync(config.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  saveMessage(message: StoredMessage): number {
    const insert = this.db.prepare(`
      INSERT INTO messages (
        platform_message_id, source_type, target_id, group_id, group_name,
        user_id, nickname, group_card, role, time, text, raw_message,
        trigger, reply_to_message_id, raw_event_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_type, target_id, platform_message_id) DO UPDATE SET
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
        "SELECT id FROM messages WHERE source_type = ? AND target_id = ? AND platform_message_id = ?",
      )
      .get(message.sourceType, message.targetId, message.platformMessageId) as { id: number };

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
    return row.id;
  }

  recentMessages(
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
          "SELECT time, id FROM messages WHERE source_type = ? AND target_id = ? AND platform_message_id = ?",
        )
        .get(sourceType, targetId, beforeMessageId) as { time: number; id: number } | undefined;
      if (!anchor) {
        return [];
      }
      rows = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE source_type = ? AND target_id = ?
             AND (time < ? OR (time = ? AND id < ?))
           ORDER BY time DESC, id DESC
           LIMIT ?`,
        )
        .all(sourceType, targetId, anchor.time, anchor.time, anchor.id, boundedLimit) as unknown as StoredMessageRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE source_type = ? AND target_id = ?
           ORDER BY time DESC, id DESC
           LIMIT ?`,
        )
        .all(sourceType, targetId, boundedLimit) as unknown as StoredMessageRow[];
    }
    return rows.reverse().map((row) => this.rowToMessage(row));
  }

  getMessage(messageId: string, sourceType?: SourceType, targetId?: string): StoredMessage | null {
    const row = sourceType && targetId
      ? (this.db
          .prepare(
            "SELECT * FROM messages WHERE source_type = ? AND target_id = ? AND platform_message_id = ?",
          )
          .get(sourceType, targetId, messageId) as StoredMessageRow | undefined)
      : (this.db
          .prepare("SELECT * FROM messages WHERE platform_message_id = ? ORDER BY time DESC, id DESC LIMIT 1")
          .get(messageId) as StoredMessageRow | undefined);
    return row ? this.rowToMessage(row) : null;
  }

  searchMessages(sourceType: SourceType, targetId: string, query: string, limit: number): StoredMessage[] {
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const like = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE source_type = ? AND target_id = ?
           AND (text LIKE ? ESCAPE '\\' OR raw_message LIKE ? ESCAPE '\\')
         ORDER BY time DESC, id DESC
         LIMIT ?`,
      )
      .all(sourceType, targetId, like, like, boundedLimit) as unknown as StoredMessageRow[];
    return rows.reverse().map((row) => this.rowToMessage(row));
  }

  getAttachment(id: number): StoredAttachment | null {
    const row = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as AttachmentRow | undefined;
    return row ? attachmentFromRow(row) : null;
  }

  getAttachmentsForMessage(messageId: string): StoredAttachment[] {
    const message = this.getMessage(messageId);
    return message?.attachments ?? [];
  }

  updateAttachmentPath(id: number, filePath: string): void {
    this.db.prepare("UPDATE attachments SET path = ? WHERE id = ?").run(filePath, id);
  }

  claimUnreadForPrompt(
    sourceType: SourceType,
    targetId: string,
    currentMessageRowId: number,
  ): ConversationUnread {
    const cursor = this.conversationCursor(sourceType, targetId);
    const previousRowId = cursor?.last_seen_message_row_id ?? 0;
    const stats = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MIN(id) AS first_id, MAX(id) AS latest_id
         FROM messages
         WHERE source_type = ? AND target_id = ? AND id > ? AND id <= ?`,
      )
      .get(sourceType, targetId, previousRowId, currentMessageRowId) as unknown as UnreadStatsRow;

    this.markConversationPrompted(sourceType, targetId, currentMessageRowId, stats);

    return {
      unreadCount: stats.count,
    };
  }

  unreadMessages(sourceType: SourceType, targetId: string, limit: number): Record<string, unknown> {
    const cursor = this.conversationCursor(sourceType, targetId);
    const unreadCount = cursor?.last_prompt_unread_count ?? 0;
    const firstRowId = cursor?.last_prompt_first_message_row_id ?? null;
    const latestRowId = cursor?.last_prompt_latest_message_row_id ?? null;
    if (!cursor || unreadCount <= 0 || firstRowId == null || latestRowId == null) {
      return {
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
           WHERE source_type = ? AND target_id = ?
             AND id >= ? AND id <= ?
           ORDER BY id DESC
           LIMIT ?
         )
         ORDER BY id ASC`,
      )
      .all(sourceType, targetId, firstRowId, latestRowId, boundedLimit) as unknown as StoredMessageRow[];
    const messages = rows.map((row) => this.rowToMessage(row));

    return {
      target_type: sourceType,
      target_id: targetId,
      unread_count: unreadCount,
      returned_count: messages.length,
      truncated: unreadCount > messages.length,
      messages,
    };
  }

  conversationState(sourceType: SourceType, targetId: string): Record<string, unknown> {
    const count = this.db
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE source_type = ? AND target_id = ?")
      .get(sourceType, targetId) as { count: number };
    const last = this.db
      .prepare(
        "SELECT * FROM messages WHERE source_type = ? AND target_id = ? ORDER BY time DESC, id DESC LIMIT 1",
      )
      .get(sourceType, targetId) as StoredMessageRow | undefined;
    const cursor = this.conversationCursor(sourceType, targetId);
    const lastSeenRowId = cursor?.last_seen_message_row_id ?? 0;
    const unread = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM messages
         WHERE source_type = ? AND target_id = ? AND id > ?`,
      )
      .get(sourceType, targetId, lastSeenRowId) as { count: number };
    return {
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
           SELECT source_type, target_id, MAX(id) AS latest_id, COUNT(*) AS message_count
           FROM messages
           GROUP BY source_type, target_id
         ) AS counts
           ON counts.latest_id = latest.id
         ORDER BY latest.time DESC, latest.id DESC
         LIMIT ?`,
      )
      .all(boundedLimit) as unknown as Array<StoredMessageRow & { message_count: number }>;
    return rows.map((row) => ({
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
      rawEvent: JSON.parse(row.raw_event_json),
      attachments: attachments.map(attachmentFromRow),
    };
  }

  private conversationCursor(sourceType: SourceType, targetId: string): ConversationCursorRow | null {
    const row = this.db
      .prepare("SELECT * FROM conversation_cursors WHERE source_type = ? AND target_id = ?")
      .get(sourceType, targetId) as ConversationCursorRow | undefined;
    return row ?? null;
  }

  private platformMessageIdByRowId(rowId: number): string | null {
    const row = this.db
      .prepare("SELECT platform_message_id FROM messages WHERE id = ?")
      .get(rowId) as { platform_message_id: string } | undefined;
    return row?.platform_message_id ?? null;
  }

  private markConversationPrompted(
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
           source_type, target_id, last_seen_message_row_id, last_seen_platform_message_id,
           last_prompt_first_message_row_id, last_prompt_latest_message_row_id, last_prompt_unread_count,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_type, target_id) DO UPDATE SET
           last_seen_message_row_id = excluded.last_seen_message_row_id,
           last_seen_platform_message_id = excluded.last_seen_platform_message_id,
           last_prompt_first_message_row_id = excluded.last_prompt_first_message_row_id,
           last_prompt_latest_message_row_id = excluded.last_prompt_latest_message_row_id,
           last_prompt_unread_count = excluded.last_prompt_unread_count,
           updated_at = excluded.updated_at
         WHERE excluded.last_seen_message_row_id > conversation_cursors.last_seen_message_row_id`,
      )
      .run(
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        UNIQUE(source_type, target_id, platform_message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation_time
        ON messages(source_type, target_id, time, id);

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

      CREATE INDEX IF NOT EXISTS idx_attachments_message
        ON attachments(message_row_id);

      CREATE TABLE IF NOT EXISTS conversation_cursors (
        source_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        last_seen_message_row_id INTEGER NOT NULL,
        last_seen_platform_message_id TEXT NOT NULL,
        last_prompt_first_message_row_id INTEGER,
        last_prompt_latest_message_row_id INTEGER,
        last_prompt_unread_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(source_type, target_id)
      );
    `);

    this.ensureConversationCursorColumns();

    this.db.exec(`
      INSERT OR IGNORE INTO conversation_cursors (
        source_type, target_id, last_seen_message_row_id, last_seen_platform_message_id,
        last_prompt_first_message_row_id, last_prompt_latest_message_row_id, last_prompt_unread_count,
        updated_at
      )
      SELECT latest.source_type, latest.target_id, latest.id, latest.platform_message_id,
        NULL, NULL, 0, unixepoch()
      FROM messages AS latest
      INNER JOIN (
        SELECT source_type, target_id, MAX(id) AS id
        FROM messages
        GROUP BY source_type, target_id
      ) AS newest
        ON newest.source_type = latest.source_type
       AND newest.target_id = latest.target_id
       AND newest.id = latest.id;
    `);
  }

  private ensureConversationCursorColumns(): void {
    const rows = this.db
      .prepare("PRAGMA table_info(conversation_cursors)")
      .all() as unknown as Array<{ name: string }>;
    const columns = new Set(rows.map((row) => row.name));
    if (!columns.has("last_prompt_first_message_row_id")) {
      this.db.exec("ALTER TABLE conversation_cursors ADD COLUMN last_prompt_first_message_row_id INTEGER");
    }
    if (!columns.has("last_prompt_latest_message_row_id")) {
      this.db.exec("ALTER TABLE conversation_cursors ADD COLUMN last_prompt_latest_message_row_id INTEGER");
    }
    if (!columns.has("last_prompt_unread_count")) {
      this.db.exec("ALTER TABLE conversation_cursors ADD COLUMN last_prompt_unread_count INTEGER NOT NULL DEFAULT 0");
    }
  }
}

interface ConversationCursorRow {
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
