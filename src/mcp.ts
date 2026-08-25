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
import {
  buildOutboundStoredMessage,
  isQqMergedForward,
  replySegmentMessageId,
  sanitizeCqMessage,
} from "./message.js";
import { MESSAGE_QUERY_TIMEOUT_MS, runMessageQuery } from "./message_query.js";
import type { OneBotClient } from "./onebot.js";
import { expandQqForwardMessages, findQqForwardNode, type QqForwardExpansion } from "./qq_forward.js";
import { QQ_REACTION_EMOJI_IDS, TELEGRAM_REACTION_EMOJIS } from "./reactions.js";
import type { MessageStore } from "./store.js";
import {
  buildTelegramOutboundMessage,
  TelegramClient,
  type TelegramMessage,
} from "./telegram.js";
import {
  extractTelegramReplyQuote,
  resolveTelegramReplyQuote,
  telegramReplyQuoteSourceText,
  type TelegramResolvedReplyQuote,
} from "./telegram_quote.js";
import { synthesizeSpeech } from "./tts.js";
import type { BridgeConfig, ExternalEvent, MessageSegment, SourceType, StoredAttachment, StoredMessage } from "./types.js";

const QQ_SEND_DELAY_MIN_MS = 3000;
const QQ_SEND_DELAY_MAX_MS = 5000;

const MESSAGE_QUERY_TOOL_DESCRIPTION = `Run JavaScript over stored QQ and Telegram history using a read-only query environment. Use the ordinary recent, unread, and get-message tools for simple lookups; use this tool for cross-chat recall, full-text discovery, reply/context analysis, attachment lookup, timelines, and custom aggregation.

The code is the body of an async function and must return a JSON-serializable value. Available helpers:
- search(text, opts?): FTS5 search with Chinese 2/3-gram expansion and BM25 ranking. Options: platform, source_type, target_id, user_id, after, before, limit (default 20), context_limit (default 1).
- messages(opts?): filter messages by platform, source_type, target_id, user_id, message_id, reply_to_message_id, trigger, after, before, has_attachments, order (asc/desc), and limit (default 50).
- context(row_id, opts?): get the target message, attachments, reply chain, and nearby messages. Options: before (default 10), after (default 10), reply_depth (default 5).
- conversations(opts?): aggregate conversations by platform/source_type/target_id. Options: platform, source_type, target_id, user_id, after, before, min_messages, limit (default 50).
- sql(query, ...params): run one read-only SELECT or WITH query for custom joins and aggregations.
- schema(table?): inspect the live messages, attachments, and messages_fts schema plus helper signatures.

Message helpers return row_id as the stable internal id accepted by context(). Time fields are Unix seconds; after/before accept Unix seconds or ISO-8601 strings. Helper limits are defaults, not maximums.

Examples:
return search("电路图", { platform: "qq", context_limit: 2 });
const rows = sql("SELECT user_id, COUNT(*) AS count FROM messages WHERE target_id = ? GROUP BY user_id ORDER BY count DESC", "728563593"); return rows;`;

const MESSAGE_QUERY_EMBEDDING_TOOL_DESCRIPTION = `Run JavaScript over stored QQ and Telegram history using a read-only query environment. Use ordinary recent, unread, and get-message tools for simple lookups; use this tool for cross-chat recall, semantic or full-text discovery, reply/context analysis, attachment lookup, timelines, and custom aggregation.

The code is the body of an async function and must return a JSON-serializable value. Available helpers:
- search(text, opts?): message search. mode is lexical, semantic, or hybrid (default). Hybrid combines Chinese FTS5/BM25 and semantic similarity. Other options: platform, source_type, target_id, user_id, after, before, limit (default 20), context_limit (default 1). Use await for semantic or hybrid searches.
- embed(text): return a binary float32 query vector for sql(); use await.
- messages(opts?): filter messages by platform, source_type, target_id, user_id, message_id, reply_to_message_id, trigger, after, before, has_attachments, order (asc/desc), and limit (default 50).
- context(row_id, opts?): get the target message, attachments, reply chain, and nearby messages. Options: before (default 10), after (default 10), reply_depth (default 5).
- conversations(opts?): aggregate conversations by platform/source_type/target_id. Options: platform, source_type, target_id, user_id, after, before, min_messages, limit (default 50).
- sql(query, ...params): run one read-only SELECT or WITH query for custom joins, sqlite-vec KNN, and aggregations.
- schema(table?): inspect messages, attachments, messages_fts, message_embeddings, and helper signatures.

Message helpers return row_id as the stable internal id accepted by context(). Time fields are Unix seconds; after/before accept Unix seconds or ISO-8601 strings. Helper limits are defaults, not maximums. Semantic and hybrid modes report an error if the local embedding service is unavailable; explicitly use mode: "lexical" when semantic recall is not required.

Examples:
return await search("上次谁说显卡坏了", { mode: "hybrid", platform: "qq", context_limit: 2 });
const v = await embed("串流画面问题"); return sql("SELECT m.id AS row_id, m.text, e.distance FROM message_embeddings AS e JOIN messages AS m ON m.id = e.message_row_id WHERE e.embedding MATCH ? AND e.k = ? AND e.platform = ? ORDER BY e.distance", v, 20, "qq");`;

const outboundPartSchema = z.object({
  type: z.enum(["text", "at", "image"]).describe("Part kind."),
  text: z.string().optional().describe("Text content for a text part."),
  user_id: z.string().optional().describe("QQ user id for an at part."),
  file: z.string().optional().describe("Local path or URL for an image part."),
}).describe("One ordered QQ message part; provide the field matching type.");

type OutboundPart = z.infer<typeof outboundPartSchema>;

const telegramOutboundPartSchema = z.object({
  type: z.enum(["text", "mention"]).describe("Part kind."),
  text: z.string().optional().describe("Text content, or the visible label for a user_id mention."),
  username: z.string().optional().describe("Telegram username for a mention, without @."),
  user_id: z.string().optional().describe("Telegram user id for a mention when no username is available."),
}).describe("One ordered Telegram message part; provide text or one mention target.");

type TelegramOutboundPart = z.infer<typeof telegramOutboundPartSchema>;

const telegramReplyQuoteFields = {
  reply_quote_text: z.string().max(1024).optional()
    .describe("Exact contiguous text selected from the replied Telegram message. Requires reply_to_message_id."),
  reply_quote_position_utf16: z.number().int().min(0).optional()
    .describe("UTF-16 code unit offset of reply_quote_text in the replied message; only needed when the quote text appears multiple times."),
};

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

interface TelegramRichOutbound {
  format: "html" | "markdown";
  content: string;
  summary: string;
  segments: MessageSegment[];
}

interface VoiceMessageOptions {
  text: string;
  style?: string;
}

interface TelegramReplyQuoteArgs {
  chat_id: string;
  reply_to_message_id?: string;
  reply_quote_text?: string;
  reply_quote_position_utf16?: number;
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

export function createBridgeMcpServer(
  config: BridgeConfig,
  onebot: OneBotClient,
  telegram: TelegramClient | null,
  store: MessageStore,
): McpServer {
  const server = new McpServer({
    name: "astral-bridge-im",
    version: "0.1.0",
  });

  if (config.qq.enabled) {
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
    "qq_get_forward_messages",
    "Expand one stored QQ merged-forward message on demand. Returns all nested nodes in depth-first order without downloading or storing their media.",
    {
      message_id: z.string().trim().min(1),
      target_type: z.enum(["group", "private"]).optional(),
      target_id: z.string().trim().min(1).optional(),
    },
    async (args) => {
      const outer = resolveStoredQqForwardMessage(config, store, args);
      const expansion = await expandQqForwardMessages(
        outer.platformMessageId,
        (messageId) => onebot.getForwardMessage(messageId),
      );
      return structured(qqForwardMessagesResponse(outer, expansion));
    },
  );

  server.tool(
    "qq_get_unread_messages",
    "Get the current unread batch for a group or private conversation. This returns the messages counted by the latest conversation_unread_count field.",
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
  }

  server.tool(
    "query_messages",
    config.embedding.enabled
      ? MESSAGE_QUERY_EMBEDDING_TOOL_DESCRIPTION
      : MESSAGE_QUERY_TOOL_DESCRIPTION,
    {
      code: z.string().trim().min(1).describe(
        "Async JavaScript function body. Use the provided helpers and finish with return <json_value>.",
      ),
    },
    async (args) => {
      try {
        return structuredCompact(await runMessageQuery(
          config.storage.dbPath,
          args.code,
          MESSAGE_QUERY_TIMEOUT_MS,
          config.embedding,
        ));
      } catch (err) {
        return {
          ...structuredCompact({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
          isError: true,
        };
      }
    },
  );

  if (config.qq.enabled) {
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
    "Download a stored QQ attachment, including media inside a merged-forward node, to the local media cache and return its path.",
    {
      attachment_id: z.number().int().optional(),
      message_id: z.string().optional(),
      target_type: z.enum(["group", "private"]).optional(),
      target_id: z.string().trim().min(1).optional(),
      forward_node_path: z.string().trim().min(1).optional()
        .describe("Node path returned by qq_get_forward_messages, for example 4/1."),
      attachment_index: z.number().int().min(0).default(0),
    },
    async (args) => {
      let attachment: StoredAttachment | null | undefined;
      if (args.forward_node_path) {
        if (args.attachment_id != null) {
          throw new Error("attachment_id cannot be combined with forward_node_path");
        }
        if (!args.message_id) {
          throw new Error("message_id is required with forward_node_path");
        }
        const outer = resolveStoredQqForwardMessage(config, store, {
          message_id: args.message_id,
          target_type: args.target_type,
          target_id: args.target_id,
        });
        const expansion = await expandQqForwardMessages(
          outer.platformMessageId,
          (messageId) => onebot.getForwardMessage(messageId),
        );
        const node = findQqForwardNode(expansion, args.forward_node_path);
        if (!node) {
          throw new Error(`forward node not found: ${args.forward_node_path}`);
        }
        attachment = node.attachments[args.attachment_index];
      } else {
        attachment = args.attachment_id != null
          ? store.getAttachment(args.attachment_id)
          : args.message_id
            ? store.getAttachmentsForMessage(args.message_id, "qq")[args.attachment_index]
            : null;
      }
      if (!attachment) {
        throw new Error("attachment not found");
      }
      const filePath = await downloadQqAttachment(store, onebot, attachment);
      return structured(compactActionResponse({
        ok: true,
        path: filePath,
        kind: attachment.kind,
        name: attachment.name,
        mime_type: attachment.mimeType,
        size: attachment.size,
        forward_node_path: args.forward_node_path,
        attachment_index: args.forward_node_path ? args.attachment_index : undefined,
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
      message: z.string().default("").describe("Message text; when parts are present, this is appended after them."),
      images: z.array(z.string()).default([]).describe("Local image paths or URLs appended after message text."),
      parts: z.array(outboundPartSchema).optional().describe("Exact ordered text, at, and image parts."),
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
      return structured(qqMessageSendResponse(response));
    },
  );

  server.tool(
    "qq_send_private_message",
    "Send a QQ private message. Supports exact ordered text/image parts and replying to a message id.",
    {
      user_id: z.string(),
      message: z.string().default("").describe("Message text; when parts are present, this is appended after them."),
      images: z.array(z.string()).default([]).describe("Local image paths or URLs appended after message text."),
      parts: z.array(outboundPartSchema).optional().describe("Exact ordered text and image parts."),
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
      return structured(qqMessageSendResponse(response));
    },
  );

  if (config.tts.enabled) {
  server.tool(
    "qq_send_group_voice",
    "Send a QQ group voice message generated from text using the configured TTS voice. This sends a real QQ voice/record message, not a file upload.",
    {
      group_id: z.string(),
      text: z.string().trim().min(1).max(2_000),
      style: z.string().trim().max(1_000).optional(),
      reply_to_message_id: z.string().optional(),
    },
    async (args) => {
      const voice = await buildVoiceMessage(config, store, {
        text: args.text,
        style: args.style,
      });
      try {
        const sendSegments = qqVoiceSegments(voice.audioPath, args.reply_to_message_id);
        const response = await sendQqActionWithDelay(onebot, "send_group_msg", {
          group_id: Number(args.group_id),
          message: sendSegments,
        });
        await saveOutboundMessage(config, onebot, store, {
          sourceType: "group",
          targetId: args.group_id,
          action: "send_group_voice",
          response,
          segments: qqVoiceHistorySegments(voice, args.reply_to_message_id),
        });
        return structured(qqSendActionResponse(response, {
          action: "send_group_voice",
          target_type: "group",
          group_id: args.group_id,
          message_id: oneBotResponseMessageId(response),
          reply_to_message_id: args.reply_to_message_id ?? null,
          text: voice.text,
        }));
      } finally {
        deleteTempVoiceFile(voice.audioPath);
      }
    },
  );

  server.tool(
    "qq_send_private_voice",
    "Send a QQ private voice message generated from text using the configured TTS voice. This sends a real QQ voice/record message, not a file upload.",
    {
      user_id: z.string(),
      text: z.string().trim().min(1).max(2_000),
      style: z.string().trim().max(1_000).optional(),
      reply_to_message_id: z.string().optional(),
    },
    async (args) => {
      const voice = await buildVoiceMessage(config, store, {
        text: args.text,
        style: args.style,
      });
      try {
        const sendSegments = qqVoiceSegments(voice.audioPath, args.reply_to_message_id);
        const response = await sendQqActionWithDelay(onebot, "send_private_msg", {
          user_id: Number(args.user_id),
          message: sendSegments,
        });
        await saveOutboundMessage(config, onebot, store, {
          sourceType: "private",
          targetId: args.user_id,
          action: "send_private_voice",
          response,
          segments: qqVoiceHistorySegments(voice, args.reply_to_message_id),
        });
        return structured(qqSendActionResponse(response, {
          action: "send_private_voice",
          target_type: "private",
          user_id: args.user_id,
          message_id: oneBotResponseMessageId(response),
          reply_to_message_id: args.reply_to_message_id ?? null,
          text: voice.text,
        }));
      } finally {
        deleteTempVoiceFile(voice.audioPath);
      }
    },
  );
  }

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
  }
  if (telegram) {
    registerTelegramTools(server, config, telegram, store);
  }

  return server;
}

function resolveStoredQqForwardMessage(
  config: BridgeConfig,
  store: MessageStore,
  args: {
    message_id: string;
    target_type?: "group" | "private";
    target_id?: string;
  },
): StoredMessage {
  if (Boolean(args.target_type) !== Boolean(args.target_id)) {
    throw new Error("target_type and target_id must be provided together");
  }

  const candidates = args.target_type && args.target_id
    ? [store.getMessage(args.message_id, "qq", args.target_type, args.target_id)].filter(
        (message): message is StoredMessage => message != null,
      )
    : store.findMessagesByPlatformMessageId(args.message_id, "qq");
  if (candidates.length === 0) {
    throw new Error(`stored QQ message not found: ${args.message_id}`);
  }

  const allowed = candidates.filter((message) => isAllowedQqConversation(config, message));
  if (allowed.length === 0) {
    throw new Error("QQ message belongs to a conversation outside the configured whitelist");
  }
  if (allowed.length > 1) {
    throw new Error("message_id matches multiple QQ conversations; provide target_type and target_id");
  }
  const outer = allowed[0];
  if (!isQqMergedForward(outer)) {
    throw new Error(`QQ message ${args.message_id} is not a merged-forward message`);
  }
  return outer;
}

function isAllowedQqConversation(config: BridgeConfig, message: StoredMessage): boolean {
  return message.sourceType === "group"
    ? config.qq.allowedGroupIds.includes(message.targetId)
    : config.qq.allowedPrivateUserIds.includes(message.targetId);
}

function qqForwardMessagesResponse(
  outer: StoredMessage,
  expansion: QqForwardExpansion,
): Record<string, unknown> {
  return {
    ok: true,
    message_id: outer.platformMessageId,
    target_type: outer.sourceType,
    target_id: outer.targetId,
    total_nodes: expansion.nodes.length,
    warnings: expansion.warnings,
    nodes: expansion.nodes.map((node) => ({
      node_path: node.nodePath,
      depth: node.depth,
      sender_user_id: node.senderUserId,
      sender_display_name: node.senderDisplayName,
      time_unix: node.timeUnix,
      text: node.text,
      attachments: node.attachments.map((attachment, attachmentIndex) => compactActionResponse({
        attachment_index: attachmentIndex,
        kind: attachment.kind,
        name: attachment.name,
        mime_type: attachment.mimeType,
        size: attachment.size,
        file_id: attachment.fileId,
        has_remote_url: Boolean(attachment.url),
      })),
      unsupported_segment_types: node.unsupportedSegmentTypes,
    })),
  };
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

  const file = attachment.fileId ?? attachment.name;
  if (file) {
    const fallback = qqMediaFallbackAction(attachment.kind, file);
    if (fallback) {
      try {
        const response = await onebot.callAction<{ data?: unknown }>(fallback.action, fallback.params);
        const data = asRecord(response.data);
        const resolvedUrl = stringField(data, "url") ?? stringField(data, "file_url");
        if (resolvedUrl) {
          const cookies = await qqCookieCandidates(onebot, resolvedUrl);
          for (const cookie of cookies) {
            try {
              return await downloadAttachmentFromUrl(store, attachment, resolvedUrl, {
                cookie,
                referer: "https://im.qq.com/",
                "user-agent": "Mozilla/5.0",
              });
            } catch (err) {
              errors.push(String(err));
            }
          }
          try {
            return await downloadAttachmentFromUrl(store, attachment, resolvedUrl);
          } catch (err) {
            errors.push(String(err));
          }
        }
        const resolvedFile = stringField(data, "file") ?? stringField(data, "path");
        if (resolvedFile) {
          return await downloadAttachmentFromOneBotFile(store, attachment, resolvedFile);
        }
      } catch (err) {
        errors.push(String(err));
      }
    }
  }

  throw new Error(`failed to download QQ media: ${errors.join("; ")}`);
}

function qqMediaFallbackAction(
  kind: string,
  file: string,
): { action: string; params: Record<string, unknown> } | null {
  switch (kind) {
    case "image":
      return { action: "get_image", params: { file } };
    case "record":
    case "voice":
      return { action: "get_record", params: { file, out_format: "ogg" } };
    case "file":
      return { action: "get_file", params: { file, type: "file" } };
    case "video":
      return { action: "get_file", params: { file, type: "video" } };
    default:
      return null;
  }
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
    "Get the current unread batch for a Telegram chat. This returns the messages counted by the latest conversation_unread_count field.",
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
    "Send a Telegram message. Supports ordered text and mention parts, topic thread ids, replies, and selected quote replies with reply_quote_text.",
    {
      chat_id: z.string(),
      message: z.string().default("").describe("Message text; when parts are present, this is appended after them."),
      parts: z.array(telegramOutboundPartSchema).optional().describe("Exact ordered text and mention parts."),
      reply_to_message_id: z.string().optional(),
      ...telegramReplyQuoteFields,
      message_thread_id: z.string().optional(),
    },
    async (args) => {
      const replyQuote = resolveTelegramMcpReplyQuote(store, args);
      const outbound = telegramOutboundText({
        message: args.message,
        parts: args.parts,
      });
      const response = await telegram.sendMessage({
        chatId: args.chat_id,
        text: outbound.html,
        parseMode: "HTML",
        replyToMessageId: args.reply_to_message_id,
        replyQuoteText: replyQuote?.text,
        replyQuotePositionUtf16: replyQuote?.position_utf16,
        messageThreadId: args.message_thread_id,
      });
      await saveTelegramOutboundMessage(config, telegram, store, {
        chatId: args.chat_id,
        action: "sendMessage",
        response,
        segments: outbound.segments,
        replyToMessageId: args.reply_to_message_id,
        replyQuote,
      });
      return structured(telegramMessageSendResponse(response));
    },
  );

  server.tool(
    "telegram_send_rich_message",
    "Send a Telegram rich message for structured content such as headings, lists, tables, collapsible details, code blocks, and formulas. Supports selected quote replies with reply_quote_text. Use telegram_send_file for local images/files.",
    {
      chat_id: z.string(),
      html: z.string().optional(),
      markdown: z.string().optional(),
      reply_to_message_id: z.string().optional(),
      ...telegramReplyQuoteFields,
      message_thread_id: z.string().optional(),
      is_rtl: z.boolean().optional(),
      skip_entity_detection: z.boolean().optional(),
    },
    async (args) => {
      const replyQuote = resolveTelegramMcpReplyQuote(store, args);
      const outbound = telegramRichOutbound({
        html: args.html,
        markdown: args.markdown,
      });
      const response = await telegram.sendRichMessage({
        chatId: args.chat_id,
        ...(outbound.format === "html" ? { html: outbound.content } : { markdown: outbound.content }),
        replyToMessageId: args.reply_to_message_id,
        replyQuoteText: replyQuote?.text,
        replyQuotePositionUtf16: replyQuote?.position_utf16,
        messageThreadId: args.message_thread_id,
        isRtl: args.is_rtl,
        skipEntityDetection: args.skip_entity_detection,
      });
      await saveTelegramOutboundMessage(config, telegram, store, {
        chatId: args.chat_id,
        action: "sendRichMessage",
        response,
        segments: outbound.segments,
        replyToMessageId: args.reply_to_message_id,
        replyQuote,
      });
      return structured(telegramMessageSendResponse(response));
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
      ...telegramReplyQuoteFields,
      message_thread_id: z.string().optional(),
    },
    async (args) => {
      const replyQuote = resolveTelegramMcpReplyQuote(store, args);
      const response = await telegram.sendFile({
        chatId: args.chat_id,
        file: args.file,
        caption: args.caption,
        replyToMessageId: args.reply_to_message_id,
        replyQuoteText: replyQuote?.text,
        replyQuotePositionUtf16: replyQuote?.position_utf16,
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
        replyQuote,
      });
      return structured(telegramMessageSendResponse(response));
    },
  );

  if (config.tts.enabled) {
    server.tool(
      "telegram_send_voice",
      "Send a Telegram voice message generated from text using the configured TTS voice. This sends a real Telegram voice message via sendVoice, not a document/file.",
      {
        chat_id: z.string(),
        text: z.string().trim().min(1).max(2_000),
        style: z.string().trim().max(1_000).optional(),
        reply_to_message_id: z.string().optional(),
        ...telegramReplyQuoteFields,
        message_thread_id: z.string().optional(),
      },
      async (args) => {
        const replyQuote = resolveTelegramMcpReplyQuote(store, args);
        const voice = await buildVoiceMessage(config, store, {
          text: args.text,
          style: args.style,
        });
        try {
          const response = await telegram.sendVoice({
            chatId: args.chat_id,
            file: voice.audioPath,
            mimeType: voice.mimeType,
            replyToMessageId: args.reply_to_message_id,
            replyQuoteText: replyQuote?.text,
            replyQuotePositionUtf16: replyQuote?.position_utf16,
            messageThreadId: args.message_thread_id,
          });
          await saveTelegramOutboundMessage(config, telegram, store, {
            chatId: args.chat_id,
            action: "sendVoice",
            response,
            segments: voice.historySegments,
            replyToMessageId: args.reply_to_message_id,
            replyQuote,
          });
          return structured(telegramMessageSendResponse(response));
        } finally {
          deleteTempVoiceFile(voice.audioPath);
        }
      },
    );
  }

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

  app.get("/api/dashboard/events", (req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({
      method: "dashboard/connected",
      params: {},
      emittedAt: new Date().toISOString(),
    })}\n\n`);

    const unsubscribe = astral.subscribeDashboardEvents((event) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    });
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(": heartbeat\n\n");
      }
    }, 15_000);

    let closed = false;
    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded) {
        res.end();
      }
    };
    req.once("close", close);
    res.once("close", close);
  });

  app.get("/api/dashboard/state", (_req: IncomingMessage, res: ServerResponse) => {
    writeJson(res, 200, dashboardState(config, onebot, telegram, astral, externalEventBatcher));
  });

  app.post("/api/astral/thread/rotate", async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!isAuthorizedEventRequest(config, req)) {
        writeJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const result = await astral.rotateThread("manual_rotate");
      if (!result.rotated) {
        writeJson(res, 409, {
          ok: false,
          error: "astral turn is active; interrupt or wait before rotating thread",
          ...result,
        });
        return;
      }
      writeJson(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("config-managed") ? 409 : 500;
      error("failed to rotate astral thread", { error: message });
      writeJson(res, status, { ok: false, error: message });
    }
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
    dashboardEventsPath: "/api/dashboard/events",
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
          summary: "Submit a generic external event to the current Astral session.",
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
    replyQuote?: TelegramResolvedReplyQuote | null;
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
      replyQuote: options.replyQuote,
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

function telegramRichOutbound(options: { html?: string; markdown?: string }): TelegramRichOutbound {
  const html = options.html?.trim() ?? "";
  const markdown = options.markdown?.trim() ?? "";
  if (html && markdown) {
    throw new Error("telegram_send_rich_message requires exactly one of html or markdown, not both");
  }
  if (!html && !markdown) {
    throw new Error("telegram_send_rich_message requires non-empty html or markdown");
  }

  const format = html ? "html" : "markdown";
  const content = html || markdown;
  const summary = `rich ${format}: ${richMessagePreview(content, format)}`;
  return {
    format,
    content,
    summary,
    segments: [{ type: "text", data: { text: summary } }],
  };
}

function resolveTelegramMcpReplyQuote(
  store: MessageStore,
  args: TelegramReplyQuoteArgs,
): TelegramResolvedReplyQuote | null {
  if (args.reply_quote_text == null && args.reply_quote_position_utf16 == null) {
    return null;
  }
  if (!args.reply_to_message_id) {
    throw new Error("Telegram selected quote replies require reply_to_message_id");
  }
  if (args.reply_quote_text == null || args.reply_quote_text.trim().length === 0) {
    throw new Error("Telegram selected quote replies require non-empty reply_quote_text");
  }

  const replied = store.getMessage(args.reply_to_message_id, "telegram", "group", args.chat_id)
    ?? store.getMessage(args.reply_to_message_id, "telegram", "private", args.chat_id);
  if (!replied) {
    throw new Error(
      `Cannot send Telegram selected quote reply: replied message ${args.reply_to_message_id} was not found in chat ${args.chat_id}`,
    );
  }

  const sourceText = telegramReplyQuoteSourceText(replied);
  if (!sourceText) {
    throw new Error(
      `Cannot send Telegram selected quote reply: replied message ${args.reply_to_message_id} has no text or caption to quote`,
    );
  }

  try {
    return resolveTelegramReplyQuote(sourceText, args.reply_quote_text, args.reply_quote_position_utf16);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot send Telegram selected quote reply: ${message}`);
  }
}

function richMessagePreview(content: string, format: "html" | "markdown"): string {
  const text = format === "html" ? stripHtmlForPreview(content) : content;
  return truncateText(text.replace(/\s+/g, " ").trim(), 240);
}

function stripHtmlForPreview(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'");
}

async function buildVoiceMessage(
  config: BridgeConfig,
  store: MessageStore,
  options: VoiceMessageOptions,
): Promise<{
  text: string;
  audioPath: string;
  mimeType: string;
  historySegments: MessageSegment[];
}> {
  const text = options.text.trim();
  const speech = await synthesizeSpeech(config.tts, {
    text,
    style: options.style,
  });
  const filename = `tts/${Date.now()}-${randomUUID()}${speech.extension}`;
  const audioPath = writeMediaFile(store, filename, speech.buffer);
  return {
    text,
    audioPath,
    mimeType: speech.mimeType,
    historySegments: voiceHistorySegments(text),
  };
}

function qqVoiceSegments(audioPath: string, replyToMessageId?: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  if (replyToMessageId?.trim()) {
    segments.push({
      type: "reply",
      data: { id: oneBotId(replyToMessageId) },
    });
  }
  segments.push({ type: "record", data: { file: audioPath } });
  return segments;
}

function qqVoiceHistorySegments(
  voice: { audioPath: string; text: string; historySegments: MessageSegment[] },
  replyToMessageId?: string,
): MessageSegment[] {
  if (!replyToMessageId?.trim()) {
    return voice.historySegments;
  }
  return [
    { type: "reply", data: { id: oneBotId(replyToMessageId) } },
    ...voice.historySegments,
  ];
}

function voiceHistorySegments(text: string): MessageSegment[] {
  const summary = `[voice] ${truncateText(text, 500)}`;
  return [{ type: "text", data: { text: summary } }];
}

function deleteTempVoiceFile(audioPath: string): void {
  try {
    fs.unlinkSync(audioPath);
  } catch (err) {
    warn("failed to delete temporary voice file", {
      audioPath,
      error: String(err),
    });
  }
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

export function qqMessageSendResponse(response: unknown): Record<string, unknown> {
  return compactActionResponse({
    ok: oneBotActionOk(response),
    message_id: oneBotResponseMessageId(response),
  });
}

export function telegramMessageSendResponse(response: { message_id: number }): Record<string, unknown> {
  return {
    ok: true,
    message_id: String(response.message_id),
  };
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

export function compactStoredMessage(message: StoredMessage): Record<string, unknown> {
  const replyQuote = message.platform === "telegram" ? extractTelegramReplyQuote(message.rawEvent) : null;
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
    ...(isQqMergedForward(message) ? { forward: { expandable: true } } : {}),
    trigger: message.trigger,
    reply_to_message_id: message.replyToMessageId,
    reply_quote: replyQuote,
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
        reply_quote: message.reply_quote ?? null,
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

function structuredCompact(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: isPlainObject(value) ? value : { result: value },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
