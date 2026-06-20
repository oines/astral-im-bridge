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
import type { GroupInfo, OneBotMessageEvent, TriggerKind } from "./types.js";

const STOP_TURN_COMMAND = "/stop";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new MessageStore(config.storage);
  const onebot = new OneBotClient(config.onebot);
  const astral = new AstralAppServerClient(config.astral);

  onebot.on("message", (event) => {
    void handleOneBotMessage(config, store, onebot, astral, event).catch((err) => {
      error("failed to handle onebot message", { error: String(err) });
    });
  });

  await onebot.start();
  await startMcpServer(config, onebot, store, astral);
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

  if (sourceType === "group" && isStopTurnCommand(segments)) {
    await handleStopTurnCommand(onebot, astral, event, targetId);
    return;
  }

  let groupInfo = await fetchGroupInfoForEvent(onebot, sourceType, targetId);
  let trigger: TriggerKind = "none";

  if (sourceType === "group") {
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
  groupId: string,
): Promise<void> {
  log("received qq stop command", {
    groupId,
    userId: String(event.user_id),
    messageId: String(event.message_id),
  });

  try {
    const result = await astral.interruptActiveTurn();
    const text = result.interrupted
      ? `已停止当前 turn：${result.turnId}`
      : "当前没有正在运行的 turn。";
    await sendGroupCommandReply(onebot, groupId, event.message_id, text);
  } catch (err) {
    error("failed to stop astral turn from qq command", {
      groupId,
      messageId: String(event.message_id),
      error: String(err),
    });
    await sendGroupCommandReply(onebot, groupId, event.message_id, "停止失败，bridge 日志里有错误。");
  }
}

async function sendGroupCommandReply(
  onebot: OneBotClient,
  groupId: string,
  replyToMessageId: string | number,
  text: string,
): Promise<void> {
  await onebot.callAction("send_group_msg", {
    group_id: Number(groupId),
    message: [
      { type: "reply", data: { id: oneBotId(replyToMessageId) } },
      { type: "text", data: { text } },
    ],
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
  return textFromSegments(segments) === STOP_TURN_COMMAND;
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

function isAlwaysTriggerGroup(
  config: ReturnType<typeof loadConfig>,
  targetId: string,
): boolean {
  return config.qq.alwaysTriggerGroupIds.includes("*")
    || config.qq.alwaysTriggerGroupIds.includes(targetId);
}

function isBotSender(event: OneBotMessageEvent, botUserId: string): boolean {
  const senderId = event.sender?.user_id ?? event.user_id;
  return String(senderId ?? "") === botUserId;
}

function isBotMessageEvent(event: OneBotMessageEvent, botUserId: string): boolean {
  return event.post_type === "message_sent" || isBotSender(event, botUserId);
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
