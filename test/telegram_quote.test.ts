import assert from "node:assert/strict";
import test from "node:test";
import { buildAstralPrompt } from "../src/message.ts";
import {
  buildTelegramOutboundMessage,
  buildTelegramReplyParameters,
  buildTelegramStoredMessage,
  type TelegramMessage,
} from "../src/telegram.ts";
import {
  extractTelegramReplyQuote,
  findQuotePositionsUtf16,
  resolveTelegramReplyQuote,
  telegramReplyQuoteSourceText,
} from "../src/telegram_quote.ts";

function telegramMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 42,
    chat: {
      id: -100123,
      type: "supergroup",
      title: "Arkloop",
    },
    from: {
      id: 6995308224,
      first_name: "oines",
      username: "oines",
    },
    date: 1_700_000_000,
    text: "quoted reply",
    ...overrides,
  };
}

test("Telegram inbound prompt includes selected reply quote", () => {
  const stored = buildTelegramStoredMessage(telegramMessage({
    message_id: 100,
    text: "我说的是这段",
    reply_to_message: telegramMessage({
      message_id: 99,
      text: "前半段 后半段",
    }),
    quote: {
      text: "后半段",
      position: 4,
      is_manual: true,
    },
  }), "mention", "8942939462");

  const prompt = buildAstralPrompt(stored);

  assert.match(prompt, /reply_to_message_id: 99/);
  assert.match(prompt, /reply_quote:\ntext: 后半段\nposition_utf16: 4\nis_manual: true/);
});

test("extractTelegramReplyQuote returns compact selected quote metadata", () => {
  assert.deepEqual(extractTelegramReplyQuote({
    quote: {
      text: "选中的文字",
      position: 12,
      is_manual: true,
      entities: [{ type: "bold", offset: 0, length: 2 }],
    },
  }), {
    text: "选中的文字",
    position_utf16: 12,
    is_manual: true,
  });

  assert.equal(extractTelegramReplyQuote({ quote: { text: "" } }), null);
});

test("resolveTelegramReplyQuote infers UTF-16 position for a unique quote", () => {
  const source = "🙂abc 后半段";

  assert.deepEqual(findQuotePositionsUtf16(source, "abc"), [2]);
  assert.deepEqual(resolveTelegramReplyQuote(source, "后半段"), {
    text: "后半段",
    position_utf16: 6,
  });
});

test("resolveTelegramReplyQuote requires position when quote appears more than once", () => {
  assert.throws(
    () => resolveTelegramReplyQuote("好啊 好啊", "好啊"),
    /appears multiple times.*positions_utf16: 0, 3/,
  );

  assert.deepEqual(resolveTelegramReplyQuote("好啊 好啊", "好啊", 3), {
    text: "好啊",
    position_utf16: 3,
  });

  assert.throws(
    () => resolveTelegramReplyQuote("好啊 好啊", "好啊", 1),
    /does not point.*positions_utf16: 0, 3/,
  );
});

test("telegramReplyQuoteSourceText prefers raw Telegram text and caption", () => {
  const textMessage = buildTelegramStoredMessage(telegramMessage({
    text: "raw text",
  }), "mention", "8942939462");
  assert.equal(telegramReplyQuoteSourceText(textMessage), "raw text");

  const captionMessage = buildTelegramStoredMessage(telegramMessage({
    text: undefined,
    caption: "raw caption",
  }), "mention", "8942939462");
  assert.equal(telegramReplyQuoteSourceText(captionMessage), "raw caption");
});

test("buildTelegramReplyParameters includes selected quote fields", () => {
  assert.deepEqual(buildTelegramReplyParameters({
    replyToMessageId: "123",
    replyQuoteText: "后半段",
    replyQuotePositionUtf16: 4,
  }), {
    message_id: 123,
    quote: "后半段",
    quote_position: 4,
  });

  assert.equal(buildTelegramReplyParameters({}), null);
});

test("buildTelegramOutboundMessage stores selected quote metadata", () => {
  const stored = buildTelegramOutboundMessage({
    chatId: "-100123",
    chatTitle: "Arkloop",
    botUserId: "8942939462",
    botUsername: "Astral",
    message: telegramMessage({
      message_id: 101,
      from: { id: 8942939462, first_name: "Astral", username: "Astral" },
      text: "response",
    }),
    segments: [{ type: "text", data: { text: "response" } }],
    action: "sendMessage",
    response: { ok: true },
    replyToMessageId: "99",
    replyQuote: {
      text: "后半段",
      position_utf16: 4,
    },
  });

  assert.deepEqual((stored.rawEvent as Record<string, unknown>).bridge_reply_quote, {
    text: "后半段",
    position_utf16: 4,
  });
});
