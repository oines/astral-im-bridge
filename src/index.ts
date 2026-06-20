#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { AstralAppServerClient } from "./astral.js";
import { log, warn, error } from "./logger.js";
import {
  buildStoredMessage,
  isAtBot,
  normalizeSegments,
  replySegmentMessageId,
  targetIdFromEvent,
  textFromSegments,
} from "./message.js";
import { startMcpServer } from "./mcp.js";
import { OneBotClient } from "./onebot.js";
import { MessageStore } from "./store.js";
import {
  buildTelegramStoredMessage,
  isTelegramAtBot,
  isTelegramChatIdCommand,
  isTelegramReplyToBot,
  telegramChatIdResponse,
  telegramSourceType,
  telegramTargetId,
  telegramText,
  TelegramClient,
  type TelegramMessage,
} from "./telegram.js";
import type { BridgeConfig, GroupInfo, OneBotMessageEvent, SourceType, TriggerKind } from "./types.js";

const STOP_TURN_COMMAND = "/stop";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new MessageStore(config.storage);
  const onebot = new OneBotClient(config.onebot);
  const telegram = config.telegram.enabled ? new TelegramClient(config.telegram) : null;
  const astral = new AstralAppServerClient(config.astral);

  onebot.on("message", (event) => {
    void handleOneBotMessage(config, store, onebot, astral, event).catch((err) => {
      error("failed to handle onebot message", { error: String(err) });
    });
  });
  telegram?.on("message", (message) => {
    void handleTelegramMessage(config, store, telegram, astral, message).catch((err) => {
      error("failed to handle telegram message", { error: String(err) });
    });
  });

  await onebot.start();
  await telegram?.start();
  await startMcpServer(config, onebot, telegram, store, astral);
}

async function handleOneBotMessage(
  config: ReturnType<typeof loadConfig>,
  store: MessageStore,
  onebot: OneBotClient,
  astral: AstralAppServerClient,
  event: OneBotMessageEvent,
): Promise<void> {
  if (event.post_type !== "message") {
    return;
  }

  const sourceType = event.message_type;
  const targetId = targetIdFromEvent(event);
  if (!isAllowedTarget(config, sourceType, targetId)) {
    return;
  }

  const segments = normalizeSegments(event.message);
  const replyTo = replySegmentMessageId(segments);
  if (isBotMessageEvent(event, config.qq.botUserId)) {
    const groupInfo = await fetchGroupInfoForEvent(onebot, sourceType, targetId);
    const stored = buildStoredMessage(event, groupInfo, "bot_message", replyTo);
    store.saveMessage(stored);
    log("stored outgoing qq message from onebot event", {
      sourceType,
      targetId,
      messageId: stored.platformMessageId,
    });
    return;
  }

  if (isStopTurnCommand(segments)) {
    await handleStopTurnCommand(onebot, astral, event, sourceType, targetId);
    return;
  }

  let groupInfo = await fetchGroupInfoForEvent(onebot, sourceType, targetId);
  let trigger: TriggerKind = "none";

  if (matchesTriggerKeyword(textFromSegments(segments), config.qq.triggerKeywords)) {
    trigger = "keyword";
  } else if (sourceType === "group") {
    if (isAtBot(segments, config.qq.botUserId)) {
      trigger = "group_mention";
    } else if (replyTo && await isReplyToBot(onebot, replyTo, config.qq.botUserId)) {
      trigger = "group_reply";
    } else if (isAlwaysTriggerGroup(config, targetId)) {
      trigger = "group_always";
    }
  } else {
    trigger = "private_message";
  }

  const stored = buildStoredMessage(event, groupInfo, trigger, replyTo);
  let messageRowId: number | null = null;
  if (trigger !== "none" || config.qq.recordUntriggered) {
    messageRowId = store.saveMessage(stored);
  }

  if (trigger === "none") {
    return;
  }

  if (messageRowId != null) {
    stored.id = messageRowId;
    stored.conversationUnread = store.claimUnreadForPrompt(
      "qq",
      stored.sourceType,
      stored.targetId,
      messageRowId,
    );
  }

  log("forwarding qq message to astral", {
    sourceType,
    targetId,
    messageId: stored.platformMessageId,
    trigger,
    unreadCount: stored.conversationUnread?.unreadCount,
  });
  await astral.submitInboundMessage(stored);
}

async function handleTelegramMessage(
  config: BridgeConfig,
  store: MessageStore,
  telegram: TelegramClient,
  astral: AstralAppServerClient,
  message: TelegramMessage,
): Promise<void> {
  const botUsername = telegram.botUsername();
  if (isTelegramChatIdCommand(message, botUsername)) {
    await telegram.sendMessage({
      chatId: telegramTargetId(message),
      text: telegramChatIdResponse(message),
      replyToMessageId: String(message.message_id),
      messageThreadId: message.message_thread_id == null ? undefined : String(message.message_thread_id),
    });
    return;
  }

  const sourceType = telegramSourceType(message);
  const targetId = telegramTargetId(message);
  if (!isAllowedTelegramChat(config, targetId)) {
    return;
  }

  const botUserId = telegram.botUserId();
  if (isTelegramBotSender(message, botUserId)) {
    const stored = buildTelegramStoredMessage(message, "bot_message", botUserId);
    store.saveMessage(stored);
    log("stored outgoing telegram message from update", {
      sourceType,
      targetId,
      messageId: stored.platformMessageId,
    });
    return;
  }

  if (isTelegramStopTurnCommand(message, botUsername)) {
    await handleTelegramStopTurnCommand(telegram, astral, message);
    return;
  }

  let trigger: TriggerKind = "none";
  if (matchesTriggerKeyword(telegramText(message), config.telegram.triggerKeywords)) {
    trigger = "keyword";
  } else if (sourceType === "private") {
    trigger = "private_message";
  } else if (isTelegramAtBot(message, botUsername, botUserId)) {
    trigger = "group_mention";
  } else if (isTelegramReplyToBot(message, botUserId)) {
    trigger = "group_reply";
  } else if (isAlwaysTriggerTelegramChat(config, targetId)) {
    trigger = "group_always";
  }

  const stored = buildTelegramStoredMessage(message, trigger, botUserId);
  let messageRowId: number | null = null;
  if (trigger !== "none" || config.telegram.recordUntriggered) {
    messageRowId = store.saveMessage(stored);
  }

  if (trigger === "none") {
    return;
  }

  if (messageRowId != null) {
    stored.id = messageRowId;
    stored.conversationUnread = store.claimUnreadForPrompt(
      "telegram",
      stored.sourceType,
      stored.targetId,
      messageRowId,
    );
  }

  log("forwarding telegram message to astral", {
    sourceType,
    targetId,
    messageId: stored.platformMessageId,
    trigger,
    unreadCount: stored.conversationUnread?.unreadCount,
  });
  await astral.submitInboundMessage(stored);
}

async function fetchGroupInfoForEvent(
  onebot: OneBotClient,
  sourceType: "group" | "private",
  targetId: string,
): Promise<GroupInfo | null> {
  if (sourceType !== "group") {
    return null;
  }
  return onebot.getGroupInfo(targetId).catch((err) => {
    warn("failed to fetch group info", { groupId: targetId, error: String(err) });
    return null;
  });
}

async function handleStopTurnCommand(
  onebot: OneBotClient,
  astral: AstralAppServerClient,
  event: OneBotMessageEvent,
  sourceType: "group" | "private",
  targetId: string,
): Promise<void> {
  log("received qq stop command", {
    sourceType,
    targetId,
    userId: String(event.user_id),
    messageId: String(event.message_id),
  });

  try {
    const result = await astral.interruptActiveTurn();
    const text = result.interrupted
      ? `已停止当前 turn：${result.turnId}`
      : "当前没有正在运行的 turn。";
    await sendQqCommandReply(onebot, sourceType, targetId, event.message_id, text);
  } catch (err) {
    error("failed to stop astral turn from qq command", {
      sourceType,
      targetId,
      messageId: String(event.message_id),
      error: String(err),
    });
    await sendQqCommandReply(onebot, sourceType, targetId, event.message_id, "停止失败，bridge 日志里有错误。");
  }
}

async function sendQqCommandReply(
  onebot: OneBotClient,
  sourceType: "group" | "private",
  targetId: string,
  replyToMessageId: string | number,
  text: string,
): Promise<void> {
  const message = [
    { type: "reply", data: { id: oneBotId(replyToMessageId) } },
    { type: "text", data: { text } },
  ];
  if (sourceType === "group") {
    await onebot.callAction("send_group_msg", {
      group_id: Number(targetId),
      message,
    });
    return;
  }
  await onebot.callAction("send_private_msg", {
    user_id: Number(targetId),
    message,
  });
}

function oneBotId(value: string | number): string | number {
  if (typeof value === "number") {
    return value;
  }
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isSafeInteger(numeric) && String(numeric) === trimmed) {
    return numeric;
  }
  return trimmed;
}

function isStopTurnCommand(segments: ReturnType<typeof normalizeSegments>): boolean {
  return textFromSegments(segments).toLocaleLowerCase() === STOP_TURN_COMMAND;
}

function isTelegramStopTurnCommand(message: TelegramMessage, botUsername: string): boolean {
  const text = telegramText(message).toLocaleLowerCase();
  if (text === STOP_TURN_COMMAND) {
    return true;
  }
  const username = botUsername.trim().toLocaleLowerCase();
  return Boolean(username) && text === `${STOP_TURN_COMMAND}@${username}`;
}

function matchesTriggerKeyword(text: string, keywords: string[]): boolean {
  if (!text || keywords.length === 0) {
    return false;
  }
  const normalizedText = text.toLocaleLowerCase();
  return keywords.some((keyword) => normalizedText.includes(keyword.toLocaleLowerCase()));
}

function isAllowedTarget(
  config: ReturnType<typeof loadConfig>,
  sourceType: "group" | "private",
  targetId: string,
): boolean {
  const list = sourceType === "group"
    ? [...config.qq.allowedGroupIds, ...config.qq.alwaysTriggerGroupIds]
    : config.qq.allowedPrivateUserIds;
  return list.includes("*") || list.includes(targetId);
}

function isAllowedTelegramChat(
  config: BridgeConfig,
  targetId: string,
): boolean {
  const list = [...config.telegram.allowedChatIds, ...config.telegram.alwaysTriggerChatIds];
  return list.includes("*") || list.includes(targetId);
}

function isAlwaysTriggerGroup(
  config: ReturnType<typeof loadConfig>,
  targetId: string,
): boolean {
  return config.qq.alwaysTriggerGroupIds.includes("*")
    || config.qq.alwaysTriggerGroupIds.includes(targetId);
}

function isAlwaysTriggerTelegramChat(
  config: BridgeConfig,
  targetId: string,
): boolean {
  return config.telegram.alwaysTriggerChatIds.includes("*")
    || config.telegram.alwaysTriggerChatIds.includes(targetId);
}

function isBotSender(event: OneBotMessageEvent, botUserId: string): boolean {
  const senderId = event.sender?.user_id ?? event.user_id;
  return String(senderId ?? "") === botUserId;
}

function isBotMessageEvent(event: OneBotMessageEvent, botUserId: string): boolean {
  return event.post_type === "message_sent" || isBotSender(event, botUserId);
}

function isTelegramBotSender(message: TelegramMessage, botUserId: string): boolean {
  return Boolean(botUserId) && String(message.from?.id ?? "") === botUserId;
}

async function handleTelegramStopTurnCommand(
  telegram: TelegramClient,
  astral: AstralAppServerClient,
  message: TelegramMessage,
): Promise<void> {
  log("received telegram stop command", {
    chatId: String(message.chat.id),
    userId: String(message.from?.id ?? ""),
    messageId: String(message.message_id),
  });

  try {
    const result = await astral.interruptActiveTurn();
    const text = result.interrupted
      ? `已停止当前 turn：${result.turnId}`
      : "当前没有正在运行的 turn。";
    await telegram.sendMessage({
      chatId: telegramTargetId(message),
      text,
      replyToMessageId: String(message.message_id),
      messageThreadId: message.message_thread_id == null ? undefined : String(message.message_thread_id),
    });
  } catch (err) {
    error("failed to stop astral turn from telegram command", {
      chatId: String(message.chat.id),
      messageId: String(message.message_id),
      error: String(err),
    });
    await telegram.sendMessage({
      chatId: telegramTargetId(message),
      text: "停止失败，bridge 日志里有错误。",
      replyToMessageId: String(message.message_id),
      messageThreadId: message.message_thread_id == null ? undefined : String(message.message_thread_id),
    });
  }
}

async function isReplyToBot(
  onebot: OneBotClient,
  messageId: string,
  botUserId: string,
): Promise<boolean> {
  const replied = await onebot.getMessage(messageId).catch((err) => {
    warn("failed to fetch replied message", { messageId, error: String(err) });
    return null;
  });
  const sender = replied?.sender;
  return String(sender?.user_id ?? replied?.user_id ?? "") === botUserId;
}

main().catch((err) => {
  error("astral-bridge crashed", { error: String(err), stack: err instanceof Error ? err.stack : undefined });
  process.exitCode = 1;
});
