import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MessageStore } from "../src/store.ts";
import type { StoredMessage } from "../src/types.ts";

function createStore(): MessageStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astral-bridge-store-"));
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
