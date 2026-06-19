import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { error, log } from "./logger.js";
import { ensureAttachmentDownloaded } from "./media.js";
import type { OneBotClient } from "./onebot.js";
import type { MessageStore } from "./store.js";
import type { BridgeConfig, SourceType } from "./types.js";

const QQ_SEND_DELAY_MIN_MS = 3000;
const QQ_SEND_DELAY_MAX_MS = 5000;

const outboundPartSchema = z.object({
  type: z.enum(["text", "at", "image"]),
  text: z.string().optional(),
  user_id: z.string().optional(),
  file: z.string().optional(),
});

type OutboundPart = z.infer<typeof outboundPartSchema>;

interface OutboundSegmentsOptions {
  message: string;
  images: string[];
  parts?: OutboundPart[];
  replyToMessageId?: string;
}

export async function startMcpServer(
  config: BridgeConfig,
  onebot: OneBotClient,
  store: MessageStore,
): Promise<void> {
  if (config.mcp.transport === "http") {
    await startHttpMcpServer(config, onebot, store);
    return;
  }

  const server = createBridgeMcpServer(config, onebot, store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function createBridgeMcpServer(
  config: BridgeConfig,
  onebot: OneBotClient,
  store: MessageStore,
): McpServer {
  const server = new McpServer({
    name: "astral-bridge-qq",
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
    async (args) => structured(store.recentMessages(
      args.target_type as SourceType,
      args.target_id,
      args.limit,
      args.before_message_id,
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
    async (args) => structured(store.getMessage(
      args.message_id,
      args.target_type as SourceType | undefined,
      args.target_id,
    )),
  );

  server.tool(
    "qq_get_unread_messages",
    "Get the current unread batch for a group or private conversation. This returns the messages counted by the latest conversation_unread prompt.",
    {
      target_type: z.enum(["group", "private"]),
      target_id: z.string(),
      limit: z.number().int().min(1).max(100).default(100),
    },
    async (args) => structured(store.unreadMessages(
      args.target_type as SourceType,
      args.target_id,
      args.limit,
    )),
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
    async (args) => structured(store.searchMessages(
      args.target_type as SourceType,
      args.target_id,
      args.query,
      args.limit,
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
      configured_private_users: config.qq.allowedPrivateUserIds,
      conversation: store.conversationState(args.target_type as SourceType, args.target_id),
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
          ? store.getAttachmentsForMessage(args.message_id)[args.attachment_index]
          : null;
      if (!attachment) {
        throw new Error("attachment not found");
      }
      const filePath = await ensureAttachmentDownloaded(store, attachment);
      return structured({ path: filePath, attachment });
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
      const response = await sendQqActionWithDelay(onebot, "send_group_msg", {
        group_id: Number(args.group_id),
        message: outboundSegments({
          message: args.message,
          images: args.images,
          parts: args.parts,
          replyToMessageId: args.reply_to_message_id,
        }),
      });
      return structured(response);
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
      const response = await sendQqActionWithDelay(onebot, "send_private_msg", {
        user_id: Number(args.user_id),
        message: outboundSegments({
          message: args.message,
          images: args.images,
          parts: args.parts,
          replyToMessageId: args.reply_to_message_id,
        }),
      });
      return structured(response);
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
      return structured(response);
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
      return structured(response);
    },
  );

  return server;
}

async function startHttpMcpServer(
  config: BridgeConfig,
  onebot: OneBotClient,
  store: MessageStore,
): Promise<void> {
  const app = createMcpExpressApp({ host: config.mcp.host });

  app.get("/healthz", (_req: IncomingMessage, res: ServerResponse) => {
    writeJson(res, 200, { ok: true });
  });

  app.post(config.mcp.path, async (
    req: IncomingMessage & { body?: unknown },
    res: ServerResponse,
  ) => {
    const server = createBridgeMcpServer(config, onebot, store);
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
  });
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function sendQqActionWithDelay<T>(
  onebot: OneBotClient,
  action: string,
  params: Record<string, unknown>,
): Promise<T> {
  const delayMs = randomDelayMs(QQ_SEND_DELAY_MIN_MS, QQ_SEND_DELAY_MAX_MS);
  log("delaying qq outbound action", { action, delayMs });
  await sleep(delayMs);
  return onebot.callAction<T>(action, params);
}

function randomDelayMs(minMs: number, maxMs: number): number {
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function outboundSegments(options: OutboundSegmentsOptions): Array<Record<string, unknown>> {
  const segments: Array<Record<string, unknown>> = [];
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
    return segments;
  }

  if (options.message.trim()) {
    segments.push({ type: "text", data: { text: options.message } });
  }
  for (const image of options.images) {
    segments.push({ type: "image", data: { file: image } });
  }
  return segments;
}

function appendOutboundPart(segments: Array<Record<string, unknown>>, part: OutboundPart): void {
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
