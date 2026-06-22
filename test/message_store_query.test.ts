import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MessageStore } from "../src/store.ts";
import type { StoredMessage } from "../src/types.ts";

function createStore(): MessageStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astral-bridge-store-"));
  return createStoreAt(dir);
}

function createStoreAt(dir: string): MessageStore {
  fs.mkdirSync(dir, { recursive: true });
  return new MessageStore({
    dbPath: path.join(dir, "messages.sqlite"),
    mediaDir: path.join(dir, "media"),
    downloadMedia: false,
  });
}

function makeMessage(index: number, overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    platform: "qq",
    platformMessageId: String(index),
    sourceType: "group",
    targetId: "group-1",
    groupId: "group-1",
    groupName: "Test Group",
    userId: `user-${index % 3}`,
    nickname: `User ${index % 3}`,
    groupCard: null,
    role: null,
    time: 1_700_000_000 + index,
    text: `message ${index}`,
    rawMessage: `message ${index}`,
    trigger: "none",
    replyToMessageId: null,
    rawEvent: { index },
    attachments: [],
    ...overrides,
  };
}

test("queryMessagesAdvanced returns columns and rows for a simple SELECT", () => {
  const store = createStore();
  const result = store.queryMessagesAdvanced("SELECT 1 AS ok");

  assert.equal(result.ok, true);
  assert.deepEqual(result.columns, ["ok"]);
  assert.deepEqual(result.rows, [{ ok: 1 }]);
  assert.equal(result.returned_count, 1);
  assert.equal(result.row_limit, 50);
  assert.equal(result.truncated, false);
});

test("queryMessagesAdvanced allows semicolons inside SQL string literals", () => {
  const store = createStore();
  const result = store.queryMessagesAdvanced("SELECT ';' AS semicolon;");

  assert.deepEqual(result.rows, [{ semicolon: ";" }]);
});

test("queryMessagesAdvanced applies default and maximum row limits outside agent SQL", () => {
  const store = createStore();
  for (let i = 0; i < 120; i += 1) {
    store.saveMessage(makeMessage(i));
  }

  const defaultLimited = store.queryMessagesAdvanced("SELECT id FROM messages ORDER BY id ASC");
  assert.equal(defaultLimited.returned_count, 50);
  assert.equal(defaultLimited.row_limit, 50);
  assert.equal(defaultLimited.truncated, true);
  assert.deepEqual(defaultLimited.rows[0], { id: 1 });

  const maxLimited = store.queryMessagesAdvanced("SELECT id FROM messages ORDER BY id ASC", 500);
  assert.equal(maxLimited.returned_count, 100);
  assert.equal(maxLimited.row_limit, 100);
  assert.equal(maxLimited.truncated, true);
});

test("queryMessagesAdvanced rejects writes, admin statements, multiple statements, and WITH", () => {
  const store = createStore();
  const rejected = [
    "INSERT INTO messages (platform_message_id) VALUES ('x')",
    "UPDATE messages SET text = 'x'",
    "DELETE FROM messages",
    "DROP TABLE messages",
    "PRAGMA table_info(messages)",
    "ATTACH DATABASE '/tmp/x.sqlite' AS x",
    "SELECT 1; SELECT 2",
    "WITH x AS (SELECT 1) SELECT * FROM x",
  ];

  for (const sql of rejected) {
    assert.throws(() => store.queryMessagesAdvanced(sql), /SELECT|WITH|statement|allowed|start/i, sql);
  }
});

test("queryMessagesAdvanced truncates large cells and oversized results", () => {
  const store = createStore();
  const longText = "x".repeat(1_200);
  for (let i = 0; i < 120; i += 1) {
    store.saveMessage(makeMessage(i, {
      text: longText,
      rawMessage: longText,
    }));
  }

  const result = store.queryMessagesAdvanced("SELECT text, raw_message FROM messages ORDER BY id ASC", 100);

  assert.equal(result.truncated, true);
  assert.ok(result.returned_count < 100);
  assert.ok(result.notes.includes("cell text truncated"));
  assert.ok(result.notes.includes("result size limit reached"));
  assert.equal(String(result.rows[0]?.text).length, 503);
});

test("searchMessages uses FTS5 with Chinese bigram/trigram and mixed identifier terms", () => {
  const store = createStore();
  store.saveMessage(makeMessage(1, {
    text: "Telegram 图片读图 400，mimo-v2.5 多模态",
    rawMessage: "tg photo vision error",
  }));
  store.saveMessage(makeMessage(2, {
    text: "电路图分析已经回复过，不要 compact 后重复回复",
    rawMessage: "diagram analysis replied",
  }));
  store.saveMessage(makeMessage(3, {
    text: "memory phase2 sandbox 需要 danger_full_access",
    rawMessage: "compact memory",
  }));

  assert.deepEqual(store.searchMessages("qq", "group", "group-1", "图片", 10).map((m) => m.platformMessageId), ["1"]);
  assert.deepEqual(store.searchMessages("qq", "group", "group-1", "回复", 10).map((m) => m.platformMessageId), ["2"]);
  assert.deepEqual(store.searchMessages("qq", "group", "group-1", "电路图", 10).map((m) => m.platformMessageId), ["2"]);
  assert.deepEqual(store.searchMessages("qq", "group", "group-1", "mimo-v2.5", 10).map((m) => m.platformMessageId), ["1"]);
  assert.deepEqual(store.searchMessages("qq", "group", "group-1", "phase2", 10).map((m) => m.platformMessageId), ["3"]);
  assert.deepEqual(store.searchMessages("qq", "group", "group-1", "danger_full_access", 10).map((m) => m.platformMessageId), ["3"]);
});

test("searchMessages keeps the FTS index in sync when an existing message changes", () => {
  const store = createStore();
  store.saveMessage(makeMessage(1, {
    platformMessageId: "same",
    text: "这条消息提到图片",
    rawMessage: "这条消息提到图片",
  }));
  assert.deepEqual(store.searchMessages("qq", "group", "group-1", "图片", 10).map((m) => m.platformMessageId), ["same"]);

  store.saveMessage(makeMessage(2, {
    platformMessageId: "same",
    text: "这条消息改成回复",
    rawMessage: "这条消息改成回复",
  }));

  assert.deepEqual(store.searchMessages("qq", "group", "group-1", "图片", 10).map((m) => m.platformMessageId), []);
  assert.deepEqual(store.searchMessages("qq", "group", "group-1", "回复", 10).map((m) => m.platformMessageId), ["same"]);
});

test("searchMessages orders FTS results by relevance before recency", () => {
  const store = createStore();
  store.saveMessage(makeMessage(1, {
    text: "图片",
    rawMessage: "图片",
    time: 1_700_000_010,
  }));
  store.saveMessage(makeMessage(2, {
    text: "图片 图片 图片 读图",
    rawMessage: "图片 图片 图片 读图",
    time: 1_700_000_000,
  }));

  assert.deepEqual(store.searchMessages("qq", "group", "group-1", "图片", 10).map((m) => m.platformMessageId), ["2", "1"]);
});

test("MessageStore rebuilds FTS for existing databases during migration", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astral-bridge-store-"));
  const dbPath = path.join(dir, "messages.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE messages (
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
    INSERT INTO messages (
      platform, platform_message_id, source_type, target_id, group_id, group_name,
      user_id, nickname, group_card, role, time, text, raw_message,
      trigger, reply_to_message_id, raw_event_json
    ) VALUES (
      'telegram', '42', 'group', '-100', '-100', 'Arkloop',
      '6995308224', 'oines', NULL, NULL, 1700000042, '旧库里有电路图分析',
      '旧库里有电路图分析', 'none', NULL, '{}'
    );
  `);
  db.close();

  const store = createStoreAt(dir);
  assert.deepEqual(store.searchMessages("telegram", "group", "-100", "电路图", 10).map((m) => m.platformMessageId), ["42"]);
});

test("queryMessagesAdvanced can join messages_fts for ranked full-text lookup", () => {
  const store = createStore();
  store.saveMessage(makeMessage(1, {
    text: "图片读图失败",
    rawMessage: "图片读图失败",
  }));

  const result = store.queryMessagesAdvanced(
    `SELECT m.platform_message_id, m.text, bm25(messages_fts) AS rank
     FROM messages_fts
     JOIN messages AS m ON m.id = messages_fts.rowid
     WHERE messages_fts MATCH '图片'
     ORDER BY rank`,
  );

  assert.equal(result.returned_count, 1);
  assert.deepEqual(result.columns, ["platform_message_id", "text", "rank"]);
  assert.equal(result.rows[0]?.platform_message_id, "1");
  assert.equal(result.rows[0]?.text, "图片读图失败");
  assert.equal(typeof result.rows[0]?.rank, "number");
});
