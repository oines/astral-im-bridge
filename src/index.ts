#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { AstralAppServerClient } from "./astral.js";
import { log, warn, error } from "./logger.js";
import {
  buildStoredMessage,
  isAtBot,
  normalizeSegments,
  replySegmentMessageId,
} from "./message.js";
import { startMcpServer } from "./mcp.js";
import { OneBotClient } from "./onebot.js";
import { MessageStore } from "./store.js";
import type { GroupInfo, OneBotMessageEvent, TriggerKind } from "./types.js";

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
  await startMcpServer(config, onebot, store);
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
  const targetId = sourceType === "group" ? String(event.group_id) : String(event.user_id);
  if (!isAllowedTarget(config, sourceType, targetId)) {
    return;
  }

  const segments = normalizeSegments(event.message);
  const replyTo = replySegmentMessageId(segments);
  let groupInfo: GroupInfo | null = null;
  let trigger: TriggerKind = "none";

  if (sourceType === "group") {
    groupInfo = await onebot.getGroupInfo(targetId).catch((err) => {
      warn("failed to fetch group info", { groupId: targetId, error: String(err) });
      return null;
    });
    if (isAtBot(segments, config.qq.botUserId)) {
      trigger = "group_mention";
    } else if (replyTo && await isReplyToBot(onebot, replyTo, config.qq.botUserId)) {
      trigger = "group_reply";
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

function isAllowedTarget(
  config: ReturnType<typeof loadConfig>,
  sourceType: "group" | "private",
  targetId: string,
): boolean {
  const list = sourceType === "group"
    ? config.qq.allowedGroupIds
    : config.qq.allowedPrivateUserIds;
  return list.includes("*") || list.includes(targetId);
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
