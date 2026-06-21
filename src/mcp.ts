import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { AstralAppServerClient } from "./astral.js";
import { dashboardHtml, dashboardState } from "./dashboard.js";
import { ExternalEventBatcher } from "./event_batcher.js";
import { registerGroupAdminTools } from "./group_admin_tools.js";
import { error, log, warn } from "./logger.js";
import { downloadAttachmentFromUrl, ensureAttachmentDownloaded, writeMediaFile } from "./media.js";
import { buildOutboundStoredMessage, replySegmentMessageId, sanitizeCqMessage } from "./message.js";
import type { OneBotClient } from "./onebot.js";
import { QQ_REACTION_EMOJI_IDS, TELEGRAM_REACTION_EMOJIS } from "./reactions.js";
import type { MessageStore } from "./store.js";
import {
  buildTelegramOutboundMessage,
  TelegramClient,
  type TelegramMessage,
} from "./telegram.js";
import type { BridgeConfig, ExternalEvent, MessageSegment, SourceType, StoredAttachment, StoredMessage } from "./types.js";

const QQ_SEND_DELAY_MIN_MS = 3000;
const QQ_SEND_DELAY_MAX_MS = 5000;

const outboundPartSchema = z.object({
  type: z.enum(["text", "at", "image"]),
  text: z.string().optional(),
  user_id: z.string().optional(),
  file: z.string().optional(),
});

type OutboundPart = z.infer<typeof outboundPartSchema>;

const telegramOutboundPartSchema = z.object({
  type: z.enum(["text", "mention"]),
  text: z.string().optional(),
  username: z.string().optional(),
  user_id: z.string().optional(),
});

type TelegramOutboundPart = z.infer<typeof telegramOutboundPartSchema>;

const externalEventSchema = z.object({
  id: z.string().trim().min(1).max(200).optional(),
  source: z.string().trim().min(1).max(100),
  event_type: z.string().trim().min(1).max(100).optional(),
  type: z.string().trim().min(1).max(100).optional(),
  title: z.string().trim().max(500).optional(),
  body: z.string().max(10_000).optional(),
  text: z.string().max(10_000).optional(),
  severity: z.string().trim().min(1).max(40).default("info"),
  actor: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  dedupe_key: z.string().trim().min(1).max(500).optional(),
  occurred_at: z.union([z.string(), z.number()]).optional(),
  wants_agent_attention: z.boolean().default(true),
}).passthrough();

type ExternalEventRequest = z.infer<typeof externalEventSchema>;

interface OutboundSegmentsOptions {
  message: string;
  images: string[];
  parts?: OutboundPart[];
  replyToMessageId?: string;
}

interface SaveOutboundMessageOptions {
  sourceType: SourceType;
  targetId: string;
  action: string;
  response: unknown;
  segments: MessageSegment[];
}

interface TelegramOutboundTextOptions {
  message: string;
  parts?: TelegramOutboundPart[];
}

export async function startMcpServer(
  config: BridgeConfig,
  onebot: OneBotClient,
  telegram: TelegramClient | null,
  store: MessageStore,
  astral: AstralAppServerClient,
): Promise<void> {
  if (config.mcp.transport === "http") {
    await startHttpMcpServer(config, onebot, telegram, store, astral);
    return;
  }

  const server = createBridgeMcpServer(config, onebot, telegram, store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function createBridgeMcpServer(
  config: BridgeConfig,
  onebot: OneBotClient,
  telegram: TelegramClient | null,
  store: MessageStore,
): McpServer {
  const server = new McpServer({
    name: "astral-bridge-im",
    version: "0.1.0",
  });

  server.tool(
    "qq_get_recent_messages",
    "Get recent stored QQ messages for a group or private conversation.",
    {
      target_type: z.enum(["group", "private"]),
      target_id: z.string(),
      limit: z.number().int().min(1).max(100).default(20),
      before_message_id: z.string().optional(),
    },
    async (args) => structured(historyMessagesResponse(
      store.recentMessages(
        "qq",
        args.target_type as SourceType,
        args.target_id,
        args.limit,
        args.before_message_id,
      ),
      {
        platform: "qq",
        target_type: args.target_type,
        target_id: args.target_id,
      },
    )),
  );

  server.tool(
    "qq_get_message",
    "Get one stored QQ message by OneBot message_id.",
    {
      message_id: z.string(),
      target_type: z.enum(["group", "private"]).optional(),
      target_id: z.string().optional(),
    },
    async (args) => structured(compactStoredMessageOrNull(store.getMessage(
      args.message_id,
      "qq",
      args.target_type as SourceType | undefined,
      args.target_id,
    ))),
  );

  server.tool(
    "qq_get_unread_messages",
    "Get the current unread batch for a group or private conversation. This returns the messages counted by the latest conversation_unread prompt.",
    {
      target_type: z.enum(["group", "private"]),
      target_id: z.string(),
      limit: z.number().int().min(1).max(100).default(100),
    },
    async (args) => structured(historyUnreadResponse(store.unreadMessages(
      "qq",
      args.target_type as SourceType,
      args.target_id,
      args.limit,
    ))),
  );

  server.tool(
    "qq_search_messages",
    "Search stored QQ text messages in a group or private conversation.",
    {
      target_type: z.enum(["group", "private"]),
      target_id: z.string(),
      query: z.string(),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async (args) => structured(historyMessagesResponse(
      store.searchMessages(
        "qq",
        args.target_type as SourceType,
        args.target_id,
        args.query,
        args.limit,
      ),
      {
        platform: "qq",
        target_type: args.target_type,
        target_id: args.target_id,
        query: args.query,
      },
    )),
  );

  server.tool(
    "qq_get_conversation_state",
    "Get bridge state for a QQ conversation.",
    {
      target_type: z.enum(["group", "private"]),
      target_id: z.string(),
    },
    async (args) => structured({
      bot_user_id: config.qq.botUserId,
      configured_groups: config.qq.allowedGroupIds,
      always_trigger_groups: config.qq.alwaysTriggerGroupIds,
      configured_private_users: config.qq.allowedPrivateUserIds,
      conversation: store.conversationState("qq", args.target_type as SourceType, args.target_id),
    }),
  );

  server.tool(
    "qq_download_media",
    "Download a stored QQ image/file attachment to the local media cache and return its path.",
    {
      attachment_id: z.number().int().optional(),
      message_id: z.string().optional(),
      attachment_index: z.number().int().min(0).default(0),
    },
    async (args) => {
      const attachment = args.attachment_id != null
        ? store.getAttachment(args.attachment_id)
        : args.message_id
          ? store.getAttachmentsForMessage(args.message_id, "qq")[args.attachment_index]
          : null;
      if (!attachment) {
        throw new Error("attachment not found");
      }
      const filePath = await downloadQqAttachment(store, onebot, attachment);
      return structured(compactActionResponse({
        ok: true,
        platform: "qq",
        action: "download_media",
        path: filePath,
        attachment: compactAttachment(attachment),
      }));
    },
  );

  server.tool(
    "qq_download_user_avatar",
    "Download the latest QQ user avatar to the local media directory and return the local image path.",
    {
      user_id: z.string(),
      size: z.number().int().min(1).max(640).default(640),
    },
    async (args) => {
      const avatar = await downloadQqUserAvatar(store, args.user_id, args.size);
      return structured(compactActionResponse({
        ok: true,
        platform: "qq",
        action: "download_user_avatar",
        user_id: args.user_id,
        path: avatar.path,
        mime_type: avatar.mimeType,
        size: avatar.size,
      }));
    },
  );

  server.tool(
    "qq_set_reaction",
    `React to a stored QQ group message with a QQ emoji id. QQ only supports message reactions in group chats. Available/common emoji_id values: ${QQ_REACTION_EMOJI_IDS}.`,
    {
      message_id: z.string(),
      emoji_id: z.string().default("76"),
      group_id: z.string().optional(),
    },
    async (args) => {
      const stored = args.group_id
        ? store.getMessage(args.message_id, "qq", "group", args.group_id)
        : store.getMessage(args.message_id, "qq");
      if (!stored) {
        throw new Error("qq_set_reaction requires a stored QQ group message_id");
      }
      if (stored.sourceType !== "group") {
        throw new Error("qq_set_reaction only supports QQ group messages");
      }
      const response = await onebot.callAction("set_msg_emoji_like", {
        message_id: oneBotId(args.message_id),
        emoji_id: args.emoji_id,
      });
      log("qq set reaction completed", {
        groupId: stored.targetId,
        messageId: args.message_id,
        emojiId: args.emoji_id,
      });
      return structured(compactActionResponse({
        ok: oneBotActionOk(response),
        platform: "qq",
        action: "set_reaction",
        message_id: args.message_id,
        group_id: stored.targetId,
        emoji_id: args.emoji_id,
        status: oneBotActionStatus(response),
      }));
    },
  );

  server.tool(
    "qq_send_group_message",
    "Send a QQ group message. Supports exact ordered parts for mixed text, @mentions, and images.",
    {
      group_id: z.string(),
      message: z.string().default(""),
      images: z.array(z.string()).default([]),
      parts: z.array(outboundPartSchema).optional(),
      reply_to_message_id: z.string().optional(),
    },
    async (args) => {
      const message = outboundSegments({
        message: args.message,
        images: args.images,
        parts: args.parts,
        replyToMessageId: args.reply_to_message_id,
      });
      const response = await sendQqActionWithDelay(onebot, "send_group_msg", {
        group_id: Number(args.group_id),
        message,
      });
      await saveOutboundMessage(config, onebot, store, {
        sourceType: "group",
        targetId: args.group_id,
        action: "send_group_msg",
        response,
        segments: message,
      });
      return structured(qqSendActionResponse(response, {
        action: "send_group_message",
        target_type: "group",
        group_id: args.group_id,
        message_id: oneBotResponseMessageId(response),
        reply_to_message_id: args.reply_to_message_id ?? null,
        text: args.message,
        parts_count: message.length,
      }));
    },
  );

  server.tool(
    "qq_send_private_message",
    "Send a QQ private message. Supports exact ordered text/image parts and replying to a message id.",
    {
      user_id: z.string(),
      message: z.string().default(""),
      images: z.array(z.string()).default([]),
      parts: z.array(outboundPartSchema).optional(),
      reply_to_message_id: z.string().optional(),
    },
    async (args) => {
      const message = outboundSegments({
        message: args.message,
        images: args.images,
        parts: args.parts,
        replyToMessageId: args.reply_to_message_id,
      });
      const response = await sendQqActionWithDelay(onebot, "send_private_msg", {
        user_id: Number(args.user_id),
        message,
      });
      await saveOutboundMessage(config, onebot, store, {
        sourceType: "private",
        targetId: args.user_id,
        action: "send_private_msg",
        response,
        segments: message,
      });
      return structured(qqSendActionResponse(response, {
        action: "send_private_message",
        target_type: "private",
        user_id: args.user_id,
        message_id: oneBotResponseMessageId(response),
        reply_to_message_id: args.reply_to_message_id ?? null,
        text: args.message,
        parts_count: message.length,
      }));
    },
  );

  server.tool(
    "qq_send_group_file",
    "Upload a local file or URL to a QQ group using NapCat's OneBot-compatible file action.",
    {
      group_id: z.string(),
      file: z.string(),
      name: z.string().optional(),
    },
    async (args) => {
      const response = await sendQqActionWithDelay(onebot, "upload_group_file", {
        group_id: Number(args.group_id),
        file: args.file,
        name: args.name,
      });
      await saveOutboundMessage(config, onebot, store, {
        sourceType: "group",
        targetId: args.group_id,
        action: "upload_group_file",
        response,
        segments: [{ type: "file", data: { file: args.file, name: args.name } }],
      });
      return structured(qqSendActionResponse(response, {
        action: "send_group_file",
        target_type: "group",
        group_id: args.group_id,
        file: args.file,
        name: args.name ?? null,
      }));
    },
  );

  server.tool(
    "qq_send_private_file",
    "Upload a local file or URL to a QQ private chat using NapCat's OneBot-compatible file action.",
    {
      user_id: z.string(),
      file: z.string(),
      name: z.string().optional(),
    },
    async (args) => {
      const response = await sendQqActionWithDelay(onebot, "upload_private_file", {
        user_id: Number(args.user_id),
        file: args.file,
        name: args.name,
      });
      await saveOutboundMessage(config, onebot, store, {
        sourceType: "private",
        targetId: args.user_id,
        action: "upload_private_file",
        response,
        segments: [{ type: "file", data: { file: args.file, name: args.name } }],
      });
      return structured(qqSendActionResponse(response, {
        action: "send_private_file",
        target_type: "private",
        user_id: args.user_id,
        file: args.file,
        name: args.name ?? null,
      }));
    },
  );

  registerGroupAdminTools(server, config, onebot);
  if (telegram) {
    registerTelegramTools(server, config, telegram, store);
  }

  return server;
}

async function downloadQqAttachment(
  store: MessageStore,
  onebot: OneBotClient,
  attachment: StoredAttachment,
): Promise<string> {
  const errors: string[] = [];
  try {
    return await ensureAttachmentDownloaded(store, attachment);
  } catch (err) {
    errors.push(String(err));
  }

  if (attachment.url) {
    const cookies = await qqCookieCandidates(onebot, attachment.url);
    for (const cookie of cookies) {
      try {
        return await downloadAttachmentFromUrl(store, attachment, attachment.url, {
          cookie,
          referer: "https://im.qq.com/",
          "user-agent": "Mozilla/5.0",
        });
      } catch (err) {
        errors.push(String(err));
      }
    }
  }

  if (attachment.kind === "image") {
    const file = attachment.fileId ?? attachment.name;
    if (file) {
      try {
        const response = await onebot.callAction<{ data?: unknown }>("get_image", { file });
        const data = asRecord((response as { data?: unknown }).data);
        const imageUrl = stringField(data, "url");
        if (imageUrl) {
          return await downloadAttachmentFromUrl(store, attachment, imageUrl);
        }
        const imageFile = stringField(data, "file");
        if (imageFile) {
          return await downloadAttachmentFromOneBotFile(store, attachment, imageFile);
        }
      } catch (err) {
        errors.push(String(err));
      }
    }
  }

  throw new Error(`failed to download QQ media: ${errors.join("; ")}`);
}

async function downloadQqUserAvatar(
  store: MessageStore,
  userId: string,
  size: number,
): Promise<{ path: string; mimeType: string; size: number }> {
  const normalizedSize = normalizeQqAvatarSize(size);
  const response = await fetch(`https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(userId)}&s=${normalizedSize}&v=${Date.now()}`, {
    headers: {
      "user-agent": "Mozilla/5.0",
    },
  });
  if (!response.ok) {
    throw new Error(`failed to download QQ avatar: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type")?.split(";")[0].trim() || "";
  const mimeType = contentType.startsWith("image/") ? contentType : "image/jpeg";
  const extension = extensionForMimeType(mimeType);
  const filePath = writeMediaFile(
    store,
    `qq-user-avatar-${safeFilenamePart(userId)}${extension}`,
    buffer,
  );
  return {
    path: filePath,
    mimeType,
    size: buffer.byteLength,
  };
}

function normalizeQqAvatarSize(size: number): number {
  if (size <= 40) {
    return 40;
  }
  if (size <= 100) {
    return 100;
  }
  if (size <= 140) {
    return 140;
  }
  return 640;
}

async function qqCookieCandidates(onebot: OneBotClient, url: string): Promise<string[]> {
  const host = safeHostname(url);
  const requests = [
    host ? onebot.callAction<{ data?: unknown }>("get_cookies", { domain: host }).catch(() => null) : null,
    onebot.callAction<{ data?: unknown }>("get_cookies", {}).catch(() => null),
    onebot.callAction<{ data?: unknown }>("get_credentials", {}).catch(() => null),
  ].filter(Boolean) as Promise<{ data?: unknown } | null>[];

  const responses = await Promise.all(requests);
  const cookies = responses
    .map((response) => stringField(asRecord(response?.data), "cookies"))
    .filter((cookie): cookie is string => Boolean(cookie));
  return [...new Set(cookies)];
}

async function downloadAttachmentFromOneBotFile(
  store: MessageStore,
  attachment: StoredAttachment,
  file: string,
): Promise<string> {
  if (file.startsWith("http://") || file.startsWith("https://")) {
    return downloadAttachmentFromUrl(store, attachment, file);
  }
  if (file.startsWith("file://")) {
    const fileUrl = new URL(file);
    const filePath = decodeURIComponent(fileUrl.pathname);
    if (filePath && fs.existsSync(filePath)) {
      if (attachment.id != null) {
        store.updateAttachmentPath(attachment.id, filePath);
      }
      return filePath;
    }
  }
  if (file.startsWith("/") && fs.existsSync(file)) {
    if (attachment.id != null) {
      store.updateAttachmentPath(attachment.id, file);
    }
    return file;
  }
  throw new Error(`OneBot returned a non-downloadable file path: ${file}`);
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function safeFilenamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/jpeg":
    case "image/jpg":
    default:
      return ".jpg";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value ? value : null;
}

function registerTelegramTools(
  server: McpServer,
  config: BridgeConfig,
  telegram: TelegramClient,
  store: MessageStore,
): void {
  server.tool(
    "telegram_get_recent_messages",
    "Get recent stored Telegram messages for a private chat, group, supergroup, or channel.",
    {
      chat_id: z.string(),
      target_type: z.enum(["group", "private"]).default("group"),
      limit: z.number().int().min(1).max(100).default(20),
      before_message_id: z.string().optional(),
    },
    async (args) => structured(historyMessagesResponse(
      store.recentMessages(
        "telegram",
        args.target_type as SourceType,
        args.chat_id,
        args.limit,
        args.before_message_id,
      ),
      {
        platform: "telegram",
        target_type: args.target_type,
        target_id: args.chat_id,
      },
    )),
  );

  server.tool(
    "telegram_get_message",
    "Get one stored Telegram message by Telegram message_id.",
    {
      message_id: z.string(),
      chat_id: z.string().optional(),
      target_type: z.enum(["group", "private"]).optional(),
    },
    async (args) => structured(compactStoredMessageOrNull(store.getMessage(
      args.message_id,
      "telegram",
      args.target_type as SourceType | undefined,
      args.chat_id,
    ))),
  );

  server.tool(
    "telegram_get_unread_messages",
    "Get the current unread batch for a Telegram chat. This returns the messages counted by the latest conversation_unread prompt.",
    {
      chat_id: z.string(),
      target_type: z.enum(["group", "private"]).default("group"),
      limit: z.number().int().min(1).max(100).default(100),
    },
    async (args) => structured(historyUnreadResponse(store.unreadMessages(
      "telegram",
      args.target_type as SourceType,
      args.chat_id,
      args.limit,
    ))),
  );

  server.tool(
    "telegram_search_messages",
    "Search stored Telegram text messages in one chat.",
    {
      chat_id: z.string(),
      target_type: z.enum(["group", "private"]).default("group"),
      query: z.string(),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async (args) => structured(historyMessagesResponse(
      store.searchMessages(
        "telegram",
        args.target_type as SourceType,
        args.chat_id,
        args.query,
        args.limit,
      ),
      {
        platform: "telegram",
        target_type: args.target_type,
        target_id: args.chat_id,
        query: args.query,
      },
    )),
  );

  server.tool(
    "telegram_download_media",
    "Download a stored Telegram attachment to the local media cache and return its path.",
    {
      attachment_id: z.number().int().optional(),
      message_id: z.string().optional(),
      attachment_index: z.number().int().min(0).default(0),
    },
    async (args) => {
      const attachment = args.attachment_id != null
        ? store.getAttachment(args.attachment_id)
        : args.message_id
          ? store.getAttachmentsForMessage(args.message_id, "telegram")[args.attachment_index]
          : null;
      if (!attachment) {
        throw new Error("attachment not found");
      }
      const filePath = await telegram.downloadAttachment(store, attachment);
      return structured(compactActionResponse({
        ok: true,
        platform: "telegram",
        action: "download_media",
        path: filePath,
        attachment: compactAttachment(attachment),
      }));
    },
  );

  server.tool(
    "telegram_download_user_avatar",
    "Download the latest Telegram user avatar to the local media directory and return the local image path.",
    {
      user_id: z.string(),
      photo_index: z.number().int().min(0).default(0),
    },
    async (args) => {
      const avatar = await telegram.downloadUserAvatar(store, args.user_id, args.photo_index);
      return structured(compactActionResponse({
        ok: true,
        platform: "telegram",
        action: "download_user_avatar",
        user_id: args.user_id,
        path: avatar.path,
        mime_type: avatar.mimeType,
        size: avatar.size,
      }));
    },
  );

  server.tool(
    "telegram_send_message",
    "Send a Telegram message. Supports ordered text and mention parts, topic thread ids, and replies.",
    {
      chat_id: z.string(),
      message: z.string().default(""),
      parts: z.array(telegramOutboundPartSchema).optional(),
      reply_to_message_id: z.string().optional(),
      message_thread_id: z.string().optional(),
    },
    async (args) => {
      const outbound = telegramOutboundText({
        message: args.message,
        parts: args.parts,
      });
      const response = await telegram.sendMessage({
        chatId: args.chat_id,
        text: outbound.html,
        parseMode: "HTML",
        replyToMessageId: args.reply_to_message_id,
        messageThreadId: args.message_thread_id,
      });
      await saveTelegramOutboundMessage(config, telegram, store, {
        chatId: args.chat_id,
        action: "sendMessage",
        response,
        segments: outbound.segments,
        replyToMessageId: args.reply_to_message_id,
      });
      return structured(compactActionResponse({
        ok: true,
        platform: "telegram",
        action: "send_message",
        chat_id: args.chat_id,
        chat_type: response.chat.type,
        chat_title: telegramChatTitle(response),
        message_id: String(response.message_id),
        message_thread_id: response.message_thread_id == null ? null : String(response.message_thread_id),
        reply_to_message_id: args.reply_to_message_id ?? null,
        text: telegramPlainText(outbound.segments),
      }));
    },
  );

  server.tool(
    "telegram_send_file",
    "Send a local path, Telegram file_id, or HTTP URL to a Telegram chat as a document/file. Images are sent as files to preserve quality.",
    {
      chat_id: z.string(),
      file: z.string(),
      caption: z.string().default(""),
      reply_to_message_id: z.string().optional(),
      message_thread_id: z.string().optional(),
    },
    async (args) => {
      const response = await telegram.sendFile({
        chatId: args.chat_id,
        file: args.file,
        caption: args.caption,
        replyToMessageId: args.reply_to_message_id,
        messageThreadId: args.message_thread_id,
      });
      const segments: MessageSegment[] = [
        ...(args.caption.trim() ? [{ type: "text", data: { text: args.caption } }] : []),
        { type: "file", data: { file: args.file, name: args.file.split("/").pop() } },
      ];
      await saveTelegramOutboundMessage(config, telegram, store, {
        chatId: args.chat_id,
        action: "sendDocument",
        response,
        segments,
        replyToMessageId: args.reply_to_message_id,
      });
      return structured(compactActionResponse({
        ok: true,
        platform: "telegram",
        action: "send_file",
        chat_id: args.chat_id,
        chat_type: response.chat.type,
        chat_title: telegramChatTitle(response),
        message_id: String(response.message_id),
        message_thread_id: response.message_thread_id == null ? null : String(response.message_thread_id),
        reply_to_message_id: args.reply_to_message_id ?? null,
        file: args.file,
        caption: args.caption || null,
      }));
    },
  );

  server.tool(
    "telegram_delete_message",
    "Delete or recall a Telegram message. Requires confirm:true because Telegram may delete messages for everyone when permissions allow it.",
    {
      chat_id: z.string(),
      message_id: z.string(),
      confirm: z.boolean().default(false),
    },
    async (args) => {
      if (!args.confirm) {
        throw new Error("telegram_delete_message requires confirm:true");
      }
      const response = await telegram.deleteMessage(args.chat_id, args.message_id);
      log("telegram delete message completed", {
        chatId: args.chat_id,
        messageId: args.message_id,
      });
      return structured(compactActionResponse({
        ok: response,
        platform: "telegram",
        action: "delete_message",
        chat_id: args.chat_id,
        message_id: args.message_id,
      }));
    },
  );

  server.tool(
    "telegram_set_reaction",
    `React to a Telegram group or private message with one standard reaction emoji. Use this instead of sending text when a lightweight acknowledgement is enough. Available emoji: ${TELEGRAM_REACTION_EMOJIS}.`,
    {
      chat_id: z.string(),
      message_id: z.string(),
      emoji: z.string().min(1).default("👍"),
      is_big: z.boolean().optional(),
    },
    async (args) => {
      const response = await telegram.setReaction({
        chatId: args.chat_id,
        messageId: args.message_id,
        emoji: args.emoji,
        isBig: args.is_big,
      });
      log("telegram set reaction completed", {
        chatId: args.chat_id,
        messageId: args.message_id,
        emoji: args.emoji,
      });
      return structured(compactActionResponse({
        ok: response,
        platform: "telegram",
        action: "set_reaction",
        chat_id: args.chat_id,
        message_id: args.message_id,
        emoji: args.emoji,
      }));
    },
  );

  server.tool(
    "telegram_get_conversation_state",
    "Get bridge state for a Telegram chat.",
    {
      chat_id: z.string(),
      target_type: z.enum(["group", "private"]).default("group"),
    },
    async (args) => structured({
      bot_user_id: telegram.botUserId(),
      bot_username: telegram.botUsername(),
      configured_chat_ids: config.telegram.allowedChatIds,
      always_trigger_chat_ids: config.telegram.alwaysTriggerChatIds,
      conversation: store.conversationState("telegram", args.target_type as SourceType, args.chat_id),
    }),
  );
}

async function startHttpMcpServer(
  config: BridgeConfig,
  onebot: OneBotClient,
  telegram: TelegramClient | null,
  store: MessageStore,
  astral: AstralAppServerClient,
): Promise<void> {
  const app = createMcpExpressApp({ host: config.mcp.host });
  const externalEventBatcher = new ExternalEventBatcher(
    config.externalEvents,
    (event) => astral.submitExternalEvent(event),
  );

  app.get("/healthz", (_req: IncomingMessage, res: ServerResponse) => {
    writeJson(res, 200, { ok: true });
  });

  app.get("/", (_req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = 302;
    res.setHeader("location", "/ui");
    res.end();
  });

  app.get("/ui", (_req: IncomingMessage, res: ServerResponse) => {
    writeHtml(res, 200, dashboardHtml());
  });

  app.get("/api/dashboard/state", (_req: IncomingMessage, res: ServerResponse) => {
    writeJson(res, 200, dashboardState(config, onebot, telegram, astral, store, externalEventBatcher));
  });

  if (config.externalEvents.enabled) {
    app.get(`${config.externalEvents.path}/schema`, (_req: IncomingMessage, res: ServerResponse) => {
      writeJson(res, 200, externalEventApiSchema(config));
    });

    app.post(config.externalEvents.path, async (
      req: IncomingMessage & { body?: unknown },
      res: ServerResponse,
    ) => {
      try {
        if (!isAuthorizedEventRequest(config, req)) {
          writeJson(res, 401, { ok: false, error: "unauthorized" });
          return;
        }
        const body = await readJsonBody(req, config.externalEvents.maxBodyBytes);
        const parsed = externalEventSchema.safeParse(body);
        if (!parsed.success) {
          writeJson(res, 400, {
            ok: false,
            error: "invalid event payload",
            issues: parsed.error.issues,
          });
          return;
        }

        const event = normalizeExternalEvent(parsed.data);
        let batch: unknown = null;
        if (parsed.data.wants_agent_attention) {
          batch = externalEventBatcher.enqueue(event);
          log("queued external event for astral", {
            source: event.source,
            eventType: event.eventType,
            eventId: event.id,
            batch,
          });
        }
        writeJson(res, 202, {
          ok: true,
          accepted_for_astral: parsed.data.wants_agent_attention,
          queued_for_astral: parsed.data.wants_agent_attention,
          batch,
          event,
        });
      } catch (err) {
        error("failed to handle external event", { error: String(err) });
        writeJson(res, 500, { ok: false, error: "failed to handle external event" });
      }
    });
  }

  app.post(config.mcp.path, async (
    req: IncomingMessage & { body?: unknown },
    res: ServerResponse,
  ) => {
    const server = createBridgeMcpServer(config, onebot, telegram, store);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        writeJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
      error("failed to handle mcp http request", { error: String(err) });
    }
  });

  app.get(config.mcp.path, (_req: IncomingMessage, res: ServerResponse) => {
    writeJson(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  });

  app.delete(config.mcp.path, (_req: IncomingMessage, res: ServerResponse) => {
    writeJson(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  });

  await new Promise<void>((resolve, reject) => {
    const listener = app.listen(config.mcp.port, config.mcp.host);
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  log("mcp http server listening", {
    host: config.mcp.host,
    port: config.mcp.port,
    path: config.mcp.path,
    uiPath: "/ui",
    dashboardStatePath: "/api/dashboard/state",
    eventPath: config.externalEvents.enabled ? config.externalEvents.path : null,
  });
}

function isAuthorizedEventRequest(
  config: BridgeConfig,
  req: IncomingMessage,
): boolean {
  const token = config.externalEvents.authToken;
  if (!token) {
    return true;
  }
  return req.headers.authorization === `Bearer ${token}`;
}

async function readJsonBody(
  req: IncomingMessage & { body?: unknown },
  maxBodyBytes: number,
): Promise<unknown> {
  if (req.body !== undefined) {
    const size = Buffer.byteLength(JSON.stringify(req.body), "utf8");
    if (size > maxBodyBytes) {
      throw new Error("event payload too large");
    }
    return req.body;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBodyBytes) {
      throw new Error("event payload too large");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalizeExternalEvent(payload: ExternalEventRequest): ExternalEvent {
  const now = new Date();
  const eventType = payload.event_type ?? payload.type ?? "event";
  return {
    id: payload.id ?? randomUUID(),
    source: payload.source,
    eventType,
    title: payload.title?.trim() || null,
    body: payload.body ?? payload.text ?? "",
    severity: payload.severity,
    actor: payload.actor ?? null,
    metadata: payload.metadata,
    dedupeKey: payload.dedupe_key ?? null,
    occurredAt: normalizeTimestamp(payload.occurred_at, now),
    receivedAt: now.toISOString(),
  };
}

function normalizeTimestamp(value: string | number | undefined, fallback: Date): string {
  if (value == null) {
    return fallback.toISOString();
  }
  if (typeof value === "number") {
    const millis = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toISOString();
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function writeHtml(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(body);
}

function externalEventApiSchema(config: BridgeConfig): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Astral Bridge External Event API",
      version: "0.1.0",
    },
    servers: [
      { url: `http://${config.mcp.host}:${config.mcp.port}` },
    ],
    paths: {
      [config.externalEvents.path]: {
        post: {
          summary: "Submit a generic external event to the fixed Astral session.",
          description: "Attention-worthy events are accepted immediately, debounced, merged into bounded batches, and then forwarded to Astral asynchronously.",
          security: config.externalEvents.authToken ? [{ bearerAuth: [] }] : [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ExternalEventRequest" },
                examples: {
                  minecraftPlayerJoin: {
                    value: {
                      source: "minecraft:survival-main",
                      event_type: "player_join",
                      title: "Player joined",
                      body: "Steve joined the server",
                      actor: { id: "uuid", name: "Steve" },
                      metadata: { world: "world", x: 120, y: 64, z: -33 },
                    },
                  },
                  validationOnly: {
                    value: {
                      source: "test",
                      event_type: "ping",
                      body: "schema smoke test",
                      wants_agent_attention: false,
                    },
                  },
                },
              },
            },
          },
          responses: {
            "202": {
              description: "Event accepted.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ExternalEventResponse" },
                },
              },
            },
            "400": { description: "Invalid event payload." },
            "401": { description: "Missing or invalid bearer token." },
            "500": { description: "Bridge failed while processing the event." },
          },
        },
      },
      [`${config.externalEvents.path}/schema`]: {
        get: {
          summary: "Return this OpenAPI schema.",
          responses: {
            "200": { description: "OpenAPI schema." },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
        },
      },
      schemas: {
        ExternalEventRequest: {
          type: "object",
          additionalProperties: true,
          required: ["source"],
          properties: {
            id: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description: "Optional caller-provided event id. A UUID is generated when omitted.",
            },
            source: {
              type: "string",
              minLength: 1,
              maxLength: 100,
              description: "System or integration name, such as minecraft:survival-main.",
            },
            event_type: {
              type: "string",
              minLength: 1,
              maxLength: 100,
              description: "Event kind. You can also use the alias field type.",
            },
            type: {
              type: "string",
              minLength: 1,
              maxLength: 100,
              description: "Alias for event_type.",
            },
            title: {
              type: "string",
              maxLength: 500,
              description: "Short display title.",
            },
            body: {
              type: "string",
              maxLength: 10000,
              description: "Main event text. You can also use the alias field text.",
            },
            text: {
              type: "string",
              maxLength: 10000,
              description: "Alias for body.",
            },
            severity: {
              type: "string",
              minLength: 1,
              maxLength: 40,
              default: "info",
              description: "Severity label.",
            },
            actor: {
              description: "User, process, or entity that caused the event.",
            },
            metadata: {
              type: "object",
              additionalProperties: true,
              default: {},
              description: "Structured event details.",
            },
            dedupe_key: {
              type: "string",
              minLength: 1,
              maxLength: 500,
              description: "Optional stable key supplied by the caller.",
            },
            occurred_at: {
              oneOf: [{ type: "string" }, { type: "number" }],
              description: "ISO timestamp, Unix seconds, or Unix milliseconds. Defaults to receive time.",
            },
            wants_agent_attention: {
              type: "boolean",
              default: true,
              description: "Set false to validate and accept without forwarding to Astral.",
            },
          },
        },
        ExternalEventResponse: {
          type: "object",
          required: ["ok", "accepted_for_astral", "queued_for_astral", "batch", "event"],
          properties: {
            ok: { type: "boolean" },
            accepted_for_astral: { type: "boolean" },
            queued_for_astral: {
              type: "boolean",
              description: "True when the event was queued for the debounced Astral batcher.",
            },
            batch: {
              anyOf: [
                { $ref: "#/components/schemas/ExternalEventBatchState" },
                { type: "null" },
              ],
            },
            event: { $ref: "#/components/schemas/ExternalEvent" },
          },
        },
        ExternalEventBatchState: {
          type: "object",
          required: [
            "pendingEvents",
            "droppedEvents",
            "debounceMs",
            "maxBatchEvents",
            "maxBatchBodyChars",
            "nextFlushAt",
          ],
          properties: {
            pendingEvents: { type: "integer", minimum: 0 },
            droppedEvents: {
              type: "integer",
              minimum: 0,
              description: "Events omitted from the pending batch after maxBatchEvents was reached.",
            },
            debounceMs: { type: "integer", minimum: 1 },
            maxBatchEvents: { type: "integer", minimum: 1 },
            maxBatchBodyChars: { type: "integer", minimum: 1 },
            nextFlushAt: { type: "string", format: "date-time" },
          },
        },
        ExternalEvent: {
          type: "object",
          required: [
            "id",
            "source",
            "eventType",
            "title",
            "body",
            "severity",
            "actor",
            "metadata",
            "dedupeKey",
            "occurredAt",
            "receivedAt",
          ],
          properties: {
            id: { type: "string" },
            source: { type: "string" },
            eventType: { type: "string" },
            title: { type: ["string", "null"] },
            body: { type: "string" },
            severity: { type: "string" },
            actor: {},
            metadata: { type: "object", additionalProperties: true },
            dedupeKey: { type: ["string", "null"] },
            occurredAt: { type: "string", format: "date-time" },
            receivedAt: { type: "string", format: "date-time" },
          },
        },
      },
    },
    usage: {
      credentialsFile: "/workspace/.bridge-event-api.env",
      curl: [
        "set -a",
        ". /workspace/.bridge-event-api.env",
        "set +a",
        "curl -sS -X POST \"$ASTRAL_BRIDGE_EVENT_API_URL\" \\",
        "  -H \"Authorization: Bearer $ASTRAL_BRIDGE_EVENT_API_TOKEN\" \\",
        "  -H \"Content-Type: application/json\" \\",
        "  --data '{\"source\":\"test\",\"event_type\":\"ping\",\"body\":\"hello\"}'",
      ].join("\n"),
      note: "Plain text output from Astral is not sent to QQ. Use QQ MCP send tools when an event requires QQ notification.",
    },
  };
}

async function saveTelegramOutboundMessage(
  _config: BridgeConfig,
  telegram: TelegramClient,
  store: MessageStore,
  options: {
    chatId: string;
    action: string;
    response: TelegramMessage;
    segments: MessageSegment[];
    replyToMessageId?: string | null;
  },
): Promise<void> {
  try {
    const stored = buildTelegramOutboundMessage({
      chatId: options.chatId,
      chatTitle: telegramChatTitle(options.response),
      botUserId: telegram.botUserId(),
      botUsername: telegram.botUsername(),
      message: options.response,
      segments: options.segments,
      action: options.action,
      response: options.response,
      replyToMessageId: options.replyToMessageId,
    });
    store.saveMessage(stored);
    log("stored outbound telegram message", {
      sourceType: stored.sourceType,
      targetId: stored.targetId,
      messageId: stored.platformMessageId,
      action: options.action,
    });
  } catch (err) {
    error("failed to store outbound telegram message", {
      chatId: options.chatId,
      action: options.action,
      error: String(err),
    });
  }
}

function telegramOutboundText(options: TelegramOutboundTextOptions): {
  html: string;
  segments: MessageSegment[];
} {
  const htmlParts: string[] = [];
  const plainParts: string[] = [];
  const segments: MessageSegment[] = [];

  if (options.parts && options.parts.length > 0) {
    for (const part of options.parts) {
      appendTelegramOutboundPart(part, htmlParts, plainParts, segments);
    }
  }

  if (shouldAppendTelegramMessage(options, plainParts.join(""))) {
    if (htmlParts.length > 0) {
      htmlParts.push("\n");
      plainParts.push("\n");
    }
    htmlParts.push(escapeHtml(options.message));
    plainParts.push(options.message);
    segments.push({ type: "text", data: { text: options.message } });
  }

  const html = htmlParts.join("");
  if (!html.trim()) {
    throw new Error("telegram_send_message requires non-empty message text or parts");
  }
  return { html, segments };
}

function appendTelegramOutboundPart(
  part: TelegramOutboundPart,
  htmlParts: string[],
  plainParts: string[],
  segments: MessageSegment[],
): void {
  if (part.type === "text") {
    if (part.text && part.text.length > 0) {
      htmlParts.push(escapeHtml(part.text));
      plainParts.push(part.text);
      segments.push({ type: "text", data: { text: part.text } });
    }
    return;
  }

  const username = part.username?.replace(/^@/, "").trim();
  if (username) {
    const mention = `@${username}`;
    htmlParts.push(escapeHtml(mention));
    plainParts.push(mention);
    segments.push({ type: "mention", data: { username, text: mention } });
    return;
  }

  const userId = part.user_id?.trim();
  if (userId) {
    const label = part.text?.trim() || userId;
    htmlParts.push(`<a href="tg://user?id=${escapeHtmlAttribute(userId)}">${escapeHtml(label)}</a>`);
    plainParts.push(label);
    segments.push({ type: "mention", data: { user_id: userId, text: label } });
  }
}

function shouldAppendTelegramMessage(options: TelegramOutboundTextOptions, partsText: string): boolean {
  const message = options.message.trim();
  if (!message) {
    return false;
  }
  if (!options.parts || options.parts.length === 0) {
    return true;
  }
  if (!partsText.trim()) {
    return true;
  }
  const normalizedMessage = normalizeTextForDupCheck(message);
  const normalizedParts = normalizeTextForDupCheck(partsText);
  return !normalizedMessage.includes(normalizedParts)
    && !normalizedParts.includes(normalizedMessage);
}

function telegramChatTitle(message: TelegramMessage): string | null {
  const chat = message.chat;
  const title = chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(" ").trim() ?? chat.username;
  return title || chat.username || null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      default:
        return char;
    }
  });
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

async function sendQqActionWithDelay<T>(
  onebot: OneBotClient,
  action: string,
  params: Record<string, unknown>,
): Promise<T> {
  const delayMs = randomDelayMs(QQ_SEND_DELAY_MIN_MS, QQ_SEND_DELAY_MAX_MS);
  log("delaying qq outbound action", { action, delayMs });
  await sleep(delayMs);
  const response = await onebot.callAction<T>(action, params);
  log("qq outbound action completed", { action, params: summarizeQqActionParams(params) });
  return response;
}

async function saveOutboundMessage(
  config: BridgeConfig,
  onebot: OneBotClient,
  store: MessageStore,
  options: SaveOutboundMessageOptions,
): Promise<void> {
  try {
    const groupInfo = options.sourceType === "group"
      ? await onebot.getGroupInfo(options.targetId).catch((err) => {
          warn("failed to fetch group info for outbound history", {
            groupId: options.targetId,
            error: String(err),
          });
          return null;
        })
      : null;
    const platformMessageId = oneBotResponseMessageId(options.response)
      ?? syntheticOutboundMessageId(options.sourceType, options.targetId);
    const stored = buildOutboundStoredMessage({
      platform: "qq",
      platformMessageId,
      sourceType: options.sourceType,
      targetId: options.targetId,
      groupInfo,
      botUserId: config.qq.botUserId,
      segments: options.segments,
      replyToMessageId: replySegmentMessageId(options.segments),
      action: options.action,
      response: options.response,
    });
    store.saveMessage(stored);
    log("stored outbound qq message", {
      sourceType: options.sourceType,
      targetId: options.targetId,
      messageId: platformMessageId,
      action: options.action,
    });
  } catch (err) {
    error("failed to store outbound qq message", {
      sourceType: options.sourceType,
      targetId: options.targetId,
      action: options.action,
      error: String(err),
    });
  }
}

function oneBotResponseMessageId(response: unknown): string | null {
  if (!isPlainObject(response)) {
    return null;
  }
  const direct = firstResponseId(response, ["message_id", "messageId"]);
  if (direct) {
    return direct;
  }
  const data = response.data;
  if (isPlainObject(data)) {
    return firstResponseId(data, ["message_id", "messageId"]);
  }
  return null;
}

function oneBotActionOk(response: unknown): boolean {
  if (!isPlainObject(response)) {
    return true;
  }
  return response.status === "ok" || response.retcode === 0;
}

function oneBotActionStatus(response: unknown): string | null {
  if (!isPlainObject(response)) {
    return null;
  }
  const status = response.status ?? response.message ?? response.wording;
  return status == null ? null : String(status);
}

function qqSendActionResponse(
  response: unknown,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return compactActionResponse({
    ok: oneBotActionOk(response),
    platform: "qq",
    ...fields,
    status: oneBotActionStatus(response),
  });
}

function firstResponseId(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const id = value[key];
    if (id != null && String(id).trim()) {
      return String(id);
    }
  }
  return null;
}

function syntheticOutboundMessageId(sourceType: SourceType, targetId: string): string {
  return `outbound:${sourceType}:${targetId}:${randomUUID()}`;
}

function randomDelayMs(minMs: number, maxMs: number): number {
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function outboundSegments(options: OutboundSegmentsOptions): MessageSegment[] {
  const segments: MessageSegment[] = [];
  if (options.replyToMessageId?.trim()) {
    segments.push({
      type: "reply",
      data: { id: oneBotId(options.replyToMessageId) },
    });
  }

  if (options.parts && options.parts.length > 0) {
    for (const part of options.parts) {
      appendOutboundPart(segments, part);
    }
  }

  if (shouldAppendMessageAfterParts(options)) {
    segments.push({ type: "text", data: { text: options.message } });
  }
  for (const image of options.images) {
    segments.push({ type: "image", data: { file: image } });
  }
  return segments;
}

function appendOutboundPart(segments: MessageSegment[], part: OutboundPart): void {
  switch (part.type) {
    case "text":
      if (part.text && part.text.length > 0) {
        segments.push({ type: "text", data: { text: part.text } });
      }
      return;
    case "at":
      if (part.user_id?.trim()) {
        segments.push({ type: "at", data: { qq: part.user_id.trim() } });
      }
      return;
    case "image":
      if (part.file?.trim()) {
        segments.push({ type: "image", data: { file: part.file } });
      }
      return;
  }
}

function oneBotId(value: string): string | number {
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isSafeInteger(numeric) && String(numeric) === trimmed) {
    return numeric;
  }
  return trimmed;
}

function shouldAppendMessageAfterParts(options: OutboundSegmentsOptions): boolean {
  const message = options.message.trim();
  if (!message) {
    return false;
  }
  if (!options.parts || options.parts.length === 0) {
    return true;
  }

  const textParts = options.parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!textParts) {
    return true;
  }

  const normalizedMessage = normalizeTextForDupCheck(message);
  const normalizedParts = normalizeTextForDupCheck(textParts);
  return !normalizedMessage.includes(normalizedParts)
    && !normalizedParts.includes(normalizedMessage);
}

function normalizeTextForDupCheck(value: string): string {
  return value.replace(/\s+/g, "");
}

function summarizeQqActionParams(params: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "message" && Array.isArray(value)) {
      summary.message = value.map((segment) => summarizeSegment(segment));
      continue;
    }
    summary[key] = value;
  }
  return summary;
}

function summarizeSegment(segment: unknown): unknown {
  if (!isPlainObject(segment)) {
    return segment;
  }
  if (segment.type !== "text") {
    return segment;
  }
  const data = isPlainObject(segment.data) ? segment.data : {};
  const text = typeof data.text === "string" ? data.text : "";
  return {
    ...segment,
    data: {
      ...data,
      text: text.length > 200 ? `${text.slice(0, 200)}...` : text,
    },
  };
}

function telegramPlainText(segments: MessageSegment[]): string {
  return segments.map((segment) => {
    const data = segment.data ?? {};
    switch (segment.type) {
      case "text":
        return String(data.text ?? "");
      case "mention":
        return String(data.username ? `@${data.username}` : data.text ?? data.user_id ?? "");
      case "file":
        return `[file:${String(data.name ?? data.file ?? "")}]`;
      default:
        return `[${segment.type}]`;
    }
  }).join("");
}

function historyMessagesResponse(
  messages: StoredMessage[],
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const compactMessages = messages.map(compactStoredMessage);
  return {
    ...meta,
    returned_count: compactMessages.length,
    reply_messages: replyMessageSummaries(compactMessages),
    messages: compactMessages,
  };
}

function historyUnreadResponse(value: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(value.messages)
    ? value.messages.filter(isStoredMessage).map(compactStoredMessage)
    : [];
  return {
    ...value,
    reply_messages: replyMessageSummaries(messages),
    messages,
  };
}

function compactStoredMessageOrNull(message: StoredMessage | null): Record<string, unknown> | null {
  return message ? compactStoredMessage(message) : null;
}

function compactStoredMessage(message: StoredMessage): Record<string, unknown> {
  return {
    id: message.id,
    platform: message.platform,
    message_id: message.platformMessageId,
    source_type: message.sourceType,
    target_id: message.targetId,
    group_id: message.groupId,
    group_name: message.groupName,
    sender_user_id: message.userId,
    sender_nickname: message.nickname,
    sender_group_card: message.groupCard,
    sender_role: message.role,
    sender_display_name: displayName(message),
    time_unix: message.time,
    text: message.text,
    raw_message: truncateText(sanitizeCqMessage(message.rawMessage), 500),
    trigger: message.trigger,
    reply_to_message_id: message.replyToMessageId,
    reply_to_message: message.replyToMessage
      ? {
          id: message.replyToMessage.id,
          message_id: message.replyToMessage.platformMessageId,
          source_type: message.replyToMessage.sourceType,
          target_id: message.replyToMessage.targetId,
          sender_user_id: message.replyToMessage.userId,
          sender_nickname: message.replyToMessage.nickname,
          sender_group_card: message.replyToMessage.groupCard,
          sender_role: message.replyToMessage.role,
          sender_display_name: displayName(message.replyToMessage),
          time_unix: message.replyToMessage.time,
          text: message.replyToMessage.text,
          raw_message: truncateText(sanitizeCqMessage(message.replyToMessage.rawMessage), 500),
          trigger: message.replyToMessage.trigger,
        }
      : null,
    attachments: message.attachments.map(compactAttachment),
  };
}

function replyMessageSummaries(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  return messages
    .filter((message) => message.reply_to_message_id)
    .map((message) => {
      const reply = isPlainObject(message.reply_to_message) ? message.reply_to_message : null;
      return {
        message_id: message.message_id,
        sender_display_name: message.sender_display_name,
        text: message.text,
        reply_to_message_id: message.reply_to_message_id,
        reply_to_sender_display_name: reply?.sender_display_name ?? null,
        reply_to_text: reply?.text ?? null,
      };
    });
}

function displayName(message: Pick<StoredMessage, "groupCard" | "nickname" | "userId">): string {
  return message.groupCard || message.nickname || message.userId;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function compactAttachment(attachment: StoredAttachment): Record<string, unknown> {
  return compactActionResponse({
    attachment_id: attachment.id,
    kind: attachment.kind,
    file_id: attachment.fileId,
    name: attachment.name,
    mime_type: attachment.mimeType,
    size: attachment.size,
    path: attachment.path,
    downloaded: Boolean(attachment.path),
    has_remote_url: Boolean(attachment.url),
  });
}

function compactActionResponse(fields: Record<string, unknown>): Record<string, unknown> {
  const response: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) {
      continue;
    }
    if (typeof value === "string") {
      response[key] = truncateText(value, key === "text" || key === "caption" ? 500 : 1000);
      continue;
    }
    response[key] = value;
  }
  return response;
}

function isStoredMessage(value: unknown): value is StoredMessage {
  return isPlainObject(value)
    && typeof value.platformMessageId === "string"
    && typeof value.platform === "string"
    && typeof value.sourceType === "string"
    && typeof value.targetId === "string"
    && typeof value.userId === "string"
    && typeof value.time === "number";
}

function structured(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: isPlainObject(value) ? value : { result: value },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
