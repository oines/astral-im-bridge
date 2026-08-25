import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runMessageQuery } from "../src/message_query.ts";
import { MessageStore } from "../src/store.ts";
import type { StoredMessage } from "../src/types.ts";

interface QueryFixture {
  dbPath: string;
  store: MessageStore;
}

function createFixture(): QueryFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astral-bridge-query-"));
  const dbPath = path.join(dir, "messages.sqlite");
  return {
    dbPath,
    store: new MessageStore({
      dbPath,
      mediaDir: path.join(dir, "media"),
      downloadMedia: false,
    }),
  };
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

test("query_messages exposes messages and live schema helpers", async () => {
  const { dbPath, store } = createFixture();
  store.saveMessage(makeMessage(1));
  store.saveMessage(makeMessage(2, { targetId: "group-2", groupId: "group-2" }));

  const result = await runMessageQuery(dbPath, `
    const rows = messages({ platform: "qq", target_id: "group-1", order: "asc" });
    return { rows, schema: schema("messages"), globals: { process: typeof process, require: typeof require } };
  `) as {
    rows: Array<Record<string, unknown>>;
    schema: { tables: Array<{ columns: Array<{ name: string }> }> };
    globals: { process: string; require: string };
  };

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.message_id, "1");
  assert.equal(typeof result.rows[0]?.row_id, "number");
  assert.deepEqual(result.rows[0]?.attachments, []);
  assert.ok(result.schema.tables[0]?.columns.some((column) => column.name === "raw_event_json"));
  assert.deepEqual(result.globals, { process: "undefined", require: "undefined" });
});

test("query_messages search keeps Chinese FTS5 ranking and lets code shape the result", async () => {
  const { dbPath, store } = createFixture();
  store.saveMessage(makeMessage(1, {
    text: "图片",
    rawMessage: "图片",
    time: 1_700_000_010,
  }));
  store.saveMessage(makeMessage(2, {
    text: "图片 图片 图片 电路图",
    rawMessage: "图片 图片 图片 电路图",
    time: 1_700_000_000,
  }));

  const result = await runMessageQuery(dbPath, `
    const found = search("图片", { platform: "qq", target_id: "group-1", context_limit: 0 });
    const ranked = sql(
      "SELECT m.platform_message_id AS message_id, bm25(messages_fts) AS rank FROM messages_fts JOIN messages AS m ON m.id = messages_fts.rowid WHERE messages_fts MATCH ? ORDER BY rank",
      "图片",
    );
    return {
      helper: found.hits.map(({ message_id, text, rank }) => ({ message_id, text, rank })),
      sql: ranked,
    };
  `) as { helper: Array<Record<string, unknown>>; sql: Array<Record<string, unknown>> };

  assert.deepEqual(result.helper.map((row) => row.message_id), ["2", "1"]);
  assert.deepEqual(result.sql.map((row) => row.message_id), ["2", "1"]);
  assert.equal(typeof result.helper[0]?.rank, "number");
});

test("query_messages context returns reply chain, attachments, and temporal neighbors", async () => {
  const { dbPath, store } = createFixture();
  const parentRowId = store.saveMessage(makeMessage(1, {
    text: "parent",
    rawMessage: "parent",
    attachments: [{
      kind: "image",
      fileId: "image-1",
      name: "parent.png",
      url: "https://example.com/parent.png",
      path: null,
      mimeType: "image/png",
      size: 123,
      raw: {},
    }],
  }));
  const replyRowId = store.saveMessage(makeMessage(2, {
    text: "reply",
    rawMessage: "reply",
    replyToMessageId: "1",
  }));
  store.saveMessage(makeMessage(3, {
    text: "after",
    rawMessage: "after",
    attachments: [{
      kind: "file",
      fileId: "file-3",
      name: "after.txt",
      url: null,
      path: "/tmp/after.txt",
      mimeType: "text/plain",
      size: 10,
      raw: {},
    }],
  }));

  const result = await runMessageQuery(dbPath, `return context(${replyRowId}, { before: 1, after: 1 });`) as {
    target: Record<string, unknown>;
    reply_chain: Array<Record<string, unknown>>;
    before: Array<Record<string, unknown>>;
    after: Array<Record<string, unknown>>;
  };

  assert.equal(result.target.row_id, replyRowId);
  assert.equal(result.reply_chain[0]?.row_id, parentRowId);
  assert.equal((result.reply_chain[0]?.attachments as Array<Record<string, unknown>>)[0]?.name, "parent.png");
  assert.equal(result.before[0]?.message_id, "1");
  assert.equal((result.before[0]?.attachments as Array<Record<string, unknown>>)[0]?.name, "parent.png");
  assert.equal(result.after[0]?.message_id, "3");
  assert.equal((result.after[0]?.attachments as Array<Record<string, unknown>>)[0]?.name, "after.txt");
});

test("query_messages messages and search return attachments for every message shape", async () => {
  const { dbPath, store } = createFixture();
  store.saveMessage(makeMessage(1, {
    text: "before",
    attachments: [{
      kind: "image",
      fileId: "before-image",
      name: "before.png",
      url: "https://example.com/before.png",
      path: null,
      mimeType: "image/png",
      size: 11,
      raw: {},
    }],
  }));
  store.saveMessage(makeMessage(2, {
    text: "needle",
    attachments: [{
      kind: "image",
      fileId: "hit-image",
      name: "hit.png",
      url: "https://example.com/hit.png",
      path: null,
      mimeType: "image/png",
      size: 22,
      raw: {},
    }],
  }));
  store.saveMessage(makeMessage(3, { text: "after" }));

  const result = await runMessageQuery(dbPath, `
    return {
      listed: messages({ message_id: "2" }),
      found: search("needle", { mode: "lexical", context_limit: 1 }).hits,
    };
  `) as {
    listed: Array<Record<string, unknown>>;
    found: Array<Record<string, unknown>>;
  };

  assert.equal((result.listed[0]?.attachments as Array<Record<string, unknown>>)[0]?.name, "hit.png");
  assert.equal((result.found[0]?.attachments as Array<Record<string, unknown>>)[0]?.name, "hit.png");
  const before = result.found[0]?.context_before as Array<Record<string, unknown>>;
  const after = result.found[0]?.context_after as Array<Record<string, unknown>>;
  assert.equal((before[0]?.attachments as Array<Record<string, unknown>>)[0]?.name, "before.png");
  assert.deepEqual(after[0]?.attachments, []);
});

test("query_messages conversations and SQL support custom aggregation without fixed row caps", async () => {
  const { dbPath, store } = createFixture();
  for (let i = 1; i <= 120; i += 1) {
    store.saveMessage(makeMessage(i, {
      targetId: i <= 80 ? "group-1" : "group-2",
      groupId: i <= 80 ? "group-1" : "group-2",
    }));
  }

  const result = await runMessageQuery(dbPath, `
    const groups = conversations({ platform: "qq" });
    const involving = conversations({ platform: "qq", user_id: "user-1" });
    const rows = sql("WITH ordered AS (SELECT id FROM messages ORDER BY id) SELECT id FROM ordered");
    return { groups, involving, row_count: rows.length, last_id: rows.at(-1).id };
  `) as {
    groups: Array<Record<string, unknown>>;
    involving: Array<Record<string, unknown>>;
    row_count: number;
    last_id: number;
  };

  assert.deepEqual(result.groups.map((row) => row.message_count), [40, 80]);
  assert.deepEqual(result.involving.map((row) => row.participant_count), [3, 3]);
  assert.equal(result.row_count, 120);
  assert.equal(result.last_id, 120);
});

test("query_messages keeps long cells and results larger than 64KB intact", async () => {
  const { dbPath, store } = createFixture();
  const longText = "x".repeat(80 * 1024);
  store.saveMessage(makeMessage(1, { text: longText, rawMessage: longText }));

  const result = await runMessageQuery(
    dbPath,
    `return { from_db: sql("SELECT text FROM messages WHERE id = 1")[0].text, generated: "y".repeat(80 * 1024) };`,
  ) as { from_db: string; generated: string };

  assert.equal(result.from_db.length, 80 * 1024);
  assert.equal(result.generated.length, 80 * 1024);
});

test("query_messages rejects writes and missing or non-serializable returns", async () => {
  const { dbPath, store } = createFixture();
  store.saveMessage(makeMessage(1));

  await assert.rejects(
    runMessageQuery(dbPath, `return sql("DELETE FROM messages");`),
    /read-only SELECT or WITH/i,
  );
  await assert.rejects(
    runMessageQuery(dbPath, `return sql("WITH selected AS (SELECT 1) DELETE FROM messages");`),
    /readonly database/i,
  );
  await assert.rejects(
    runMessageQuery(dbPath, `return sql("SELECT 1; SELECT 2");`),
    /one statement/i,
  );
  await assert.rejects(runMessageQuery(dbPath, "const rows = messages();"), /returned undefined/i);
  await assert.rejects(
    runMessageQuery(dbPath, "const value = {}; value.self = value; return value;"),
    /circular reference/i,
  );

  const result = await runMessageQuery(
    dbPath,
    `return { rows: sql("SELECT COUNT(*) AS count FROM messages"), semicolon: sql("SELECT ';' AS value;") };`,
  ) as { rows: Array<{ count: number }>; semicolon: Array<{ value: string }> };
  assert.equal(result.rows[0]?.count, 1);
  assert.equal(result.semicolon[0]?.value, ";");
});

test("query_messages kills synchronous and asynchronous infinite loops without poisoning later queries", async () => {
  const { dbPath } = createFixture();

  await assert.rejects(runMessageQuery(dbPath, "while (true) {}", 1_000), /timed out/i);
  await assert.rejects(
    runMessageQuery(dbPath, "await Promise.resolve(); while (true) {}", 1_000),
    /timed out/i,
  );

  const result = await runMessageQuery(dbPath, "return { alive: true };");
  assert.deepEqual(result, { alive: true });
});
