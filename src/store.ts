import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ConversationUnread,
  Platform,
  SourceType,
  StoredAttachment,
  StoredMessage,
  StoredMessageReplyPreview,
  StoredMessageRow,
  StorageConfig,
} from "./types.js";

const ADVANCED_QUERY_DEFAULT_ROWS = 50;
const ADVANCED_QUERY_MAX_ROWS = 100;
const ADVANCED_QUERY_MAX_SQL_CHARS = 5000;
const ADVANCED_QUERY_MAX_CELL_CHARS = 500;
const ADVANCED_QUERY_MAX_JSON_BYTES = 64 * 1024;
const MESSAGES_FTS_INDEX_VERSION = "1";
const MESSAGES_FTS_META_KEY = "messages_fts_index_version";

export interface AdvancedMessageQueryResult {
  ok: true;
  columns: string[];
  rows: Record<string, unknown>[];
  returned_count: number;
  row_limit: number;
  truncated: boolean;
  notes: string[];
}

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
    return row.id;
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

  queryMessagesAdvanced(sql: string, maxRows = ADVANCED_QUERY_DEFAULT_ROWS): AdvancedMessageQueryResult {
    const boundedRows = Math.min(Math.max(Math.trunc(maxRows) || ADVANCED_QUERY_DEFAULT_ROWS, 1), ADVANCED_QUERY_MAX_ROWS);
    const normalizedSql = normalizeAdvancedQuerySql(sql);
    const stmt = this.db.prepare(`SELECT * FROM (${normalizedSql}) AS advanced_message_query LIMIT ?`);
    const columns = stmt.columns().map((c) => c.name);
    const notes: string[] = [];

    let rawRows: Record<string, unknown>[];
    this.db.exec("PRAGMA query_only = ON");
    try {
      rawRows = stmt.all(boundedRows + 1) as Record<string, unknown>[];
    } finally {
      this.db.exec("PRAGMA query_only = OFF");
    }

    let truncated = false;
    if (rawRows.length > boundedRows) {
      rawRows = rawRows.slice(0, boundedRows);
      truncated = true;
      notes.push("row limit reached");
    }

    const rows = rawRows.map((row) => normalizeAdvancedQueryRow(row, notes));
    let result: AdvancedMessageQueryResult = {
      ok: true,
      columns,
      rows,
      returned_count: rows.length,
      row_limit: boundedRows,
      truncated,
      notes: uniqueNotes(notes),
    };

    result = enforceAdvancedQueryJsonLimit(result);
    return result;
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

  private setMetaValue(key: string, value: string): void {
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
      this.setMetaValue(MESSAGES_FTS_META_KEY, MESSAGES_FTS_INDEX_VERSION);
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

function buildFtsIndexText(...parts: Array<string | null | undefined>): string {
  const values = parts.map((part) => part?.trim()).filter((part): part is string => !!part);
  const tokens = new Set<string>();
  for (const value of values) {
    for (const token of cjkNgramTokens(value)) {
      tokens.add(token);
    }
  }
  return [...values, ...tokens].join(" ");
}

function buildFtsMatchQuery(query: string): string {
  const terms = new Set<string>();
  const trimmed = query.trim();
  if (!trimmed) {
    return "";
  }
  terms.add(trimmed);
  for (const term of asciiSearchTerms(trimmed)) {
    terms.add(term);
  }
  for (const term of cjkNgramTokens(trimmed)) {
    terms.add(term);
  }
  return [...terms].map(quoteFtsTerm).join(" OR ");
}

function quoteFtsTerm(term: string): string {
  return `"${term.replaceAll("\"", "\"\"")}"`;
}

function asciiSearchTerms(value: string): string[] {
  return value.match(/[A-Za-z0-9_][A-Za-z0-9_.:-]*/g) ?? [];
}

function cjkNgramTokens(value: string): string[] {
  const tokens = new Set<string>();
  for (const match of value.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)) {
    const run = match[0];
    for (const size of [2, 3]) {
      if (run.length < size) {
        continue;
      }
      for (let i = 0; i <= run.length - size; i += 1) {
        tokens.add(run.slice(i, i + size));
      }
    }
  }
  return [...tokens];
}

function normalizeAdvancedQuerySql(sql: string): string {
  let trimmed = sql.trim();
  if (!trimmed) {
    throw new Error("Query must not be empty");
  }
  if (trimmed.length > ADVANCED_QUERY_MAX_SQL_CHARS) {
    throw new Error(`Query is too long; maximum is ${ADVANCED_QUERY_MAX_SQL_CHARS} characters`);
  }

  const statementSeparator = findSqlStatementSeparator(trimmed);
  if (statementSeparator !== -1) {
    if (trimmed.slice(statementSeparator + 1).trim()) {
      throw new Error("Only one SELECT statement is allowed");
    }
    trimmed = trimmed.slice(0, statementSeparator).trimEnd();
  }

  if (/^with\b/i.test(trimmed)) {
    throw new Error("WITH queries are not supported; start with SELECT");
  }
  if (!/^select\b/i.test(trimmed)) {
    throw new Error("Query must start with SELECT");
  }

  return trimmed;
}

function findSqlStatementSeparator(sql: string): number {
  let quote: "'" | "\"" | "`" | "]" | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (quote) {
      if (quote === "]") {
        if (char === "]") {
          quote = null;
        }
        continue;
      }
      if (char === quote) {
        if ((quote === "'" || quote === "\"") && sql[i + 1] === quote) {
          i += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "[") {
      quote = "]";
      continue;
    }
    if (char === ";") {
      return i;
    }
  }
  return -1;
}

function normalizeAdvancedQueryRow(
  row: Record<string, unknown>,
  notes: string[],
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = normalizeAdvancedQueryValue(value, notes);
  }
  return normalized;
}

function normalizeAdvancedQueryValue(value: unknown, notes: string[]): unknown {
  if (typeof value === "string") {
    if (value.length > ADVANCED_QUERY_MAX_CELL_CHARS) {
      notes.push("cell text truncated");
      return `${value.slice(0, ADVANCED_QUERY_MAX_CELL_CHARS)}...`;
    }
    return value;
  }
  if (typeof value === "bigint") {
    notes.push("bigint values returned as strings");
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    notes.push("binary values omitted");
    return `<binary ${value.byteLength} bytes>`;
  }
  if (value instanceof ArrayBuffer) {
    notes.push("binary values omitted");
    return `<binary ${value.byteLength} bytes>`;
  }
  if (
    value == null
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return value;
  }
  notes.push("non-scalar values stringified");
  return String(value);
}

function enforceAdvancedQueryJsonLimit(result: AdvancedMessageQueryResult): AdvancedMessageQueryResult {
  const notes = [...result.notes];
  const adjusted: AdvancedMessageQueryResult = {
    ...result,
    notes: uniqueNotes(notes),
  };

  while (jsonByteLength(adjusted) > ADVANCED_QUERY_MAX_JSON_BYTES && adjusted.rows.length > 0) {
    adjusted.rows.pop();
    adjusted.returned_count = adjusted.rows.length;
    adjusted.truncated = true;
    notes.push("result size limit reached");
    adjusted.notes = uniqueNotes(notes);
  }

  if (jsonByteLength(adjusted) > ADVANCED_QUERY_MAX_JSON_BYTES) {
    adjusted.rows = [];
    adjusted.returned_count = 0;
    adjusted.truncated = true;
    notes.push("result metadata exceeded size limit");
    adjusted.notes = uniqueNotes(notes);
  }

  return adjusted;
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function uniqueNotes(notes: string[]): string[] {
  return [...new Set(notes)];
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
