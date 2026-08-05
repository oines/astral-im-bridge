import assert from "node:assert/strict";
import test from "node:test";
import { buildAstralPrompt } from "../src/message.ts";
import type { StoredMessage } from "../src/types.ts";

test("QQ inbound prompt keeps event context without repeating tool tutorials", () => {
  const prompt = buildAstralPrompt(message({
    platform: "qq",
    sourceType: "group",
    targetId: "728563593",
    groupId: "728563593",
    groupName: "AstralOps",
    userId: "6995308224",
    nickname: "oines",
    groupCard: "oines",
    role: "admin",
    trigger: "keyword",
    conversationUnread: { unreadCount: 7 },
  }));

  assert.match(prompt, /\[QQ inbound message\]/);
  assert.match(prompt, /group_id: 728563593/);
  assert.match(prompt, /sender_user_id: 6995308224/);
  assert.match(prompt, /conversation_unread_count: 7/);
  assert.match(prompt, /content:\nastral 你好/);
  assert.match(prompt, /ordinary assistant text is not delivered to QQ/);
  assert.doesNotMatch(prompt, /history:|reply_policy:|Available\/common emoji|Examples:|mcp__qq__/);
  assert.ok(prompt.length < 1_000);
});

test("Telegram inbound prompt keeps quote and topic context without raw entities or tutorials", () => {
  const prompt = buildAstralPrompt(message({
    platform: "telegram",
    sourceType: "group",
    targetId: "-1003707859362",
    groupId: null,
    groupName: "Arkloop",
    userId: "6995308224",
    nickname: "oines",
    groupCard: null,
    role: null,
    trigger: "mention",
    replyToMessageId: "98",
    conversationUnread: { unreadCount: 3 },
    rawEvent: {
      chat: { id: -1003707859362, type: "supergroup", title: "Arkloop" },
      from: { id: 6995308224, username: "oines", first_name: "oines" },
      message_thread_id: 42,
      entities: [{ type: "mention", offset: 0, length: 7 }],
      quote: { text: "选中的文字", position: 4, is_manual: true },
    },
  }));

  assert.match(prompt, /\[Telegram inbound message\]/);
  assert.match(prompt, /chat_id: -1003707859362/);
  assert.match(prompt, /message_thread_id: 42/);
  assert.match(prompt, /reply_quote:\ntext: 选中的文字\nposition_utf16: 4\nis_manual: true/);
  assert.match(prompt, /conversation_unread_count: 3/);
  assert.match(prompt, /ordinary assistant text is not delivered to Telegram/);
  assert.doesNotMatch(prompt, /entities:|history:|reply_policy:|Available emoji|mcp__telegram__/);
  assert.ok(prompt.length < 1_200);
});

function message(overrides: Partial<StoredMessage>): StoredMessage {
  return {
    platform: "qq",
    platformMessageId: "100",
    sourceType: "private",
    targetId: "6995308224",
    groupId: null,
    groupName: null,
    userId: "6995308224",
    nickname: "oines",
    groupCard: null,
    role: null,
    time: 1_750_000_000,
    text: "astral 你好",
    rawMessage: "astral 你好",
    trigger: "keyword",
    replyToMessageId: null,
    rawEvent: {},
    attachments: [],
    ...overrides,
  };
}
