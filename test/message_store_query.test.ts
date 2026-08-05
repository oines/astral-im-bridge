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

test("MessageStore persists bridge metadata", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astral-bridge-store-"));
  const store = createStoreAt(dir);

  assert.equal(store.getMetaValue("astral_thread_id"), null);
  store.setMetaValue("astral_thread_id", "thread-1");
  assert.equal(store.getMetaValue("astral_thread_id"), "thread-1");

  const reopened = createStoreAt(dir);
  assert.equal(reopened.getMetaValue("astral_thread_id"), "thread-1");
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
