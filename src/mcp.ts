import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { AstralAppServerClient } from "./astral.js";
import { dashboardHtml, dashboardState } from "./dashboard.js";
import { ExternalEventBatcher } from "./event_batcher.js";
import { error, log } from "./logger.js";
import { ensureAttachmentDownloaded } from "./media.js";
import type { OneBotClient } from "./onebot.js";
import type { MessageStore } from "./store.js";
import type { BridgeConfig, ExternalEvent, SourceType } from "./types.js";

const QQ_SEND_DELAY_MIN_MS = 3000;
const QQ_SEND_DELAY_MAX_MS = 5000;

const outboundPartSchema = z.object({
  type: z.enum(["text", "at", "image"]),
  text: z.string().optional(),
  user_id: z.string().optional(),
  file: z.string().optional(),
});

type OutboundPart = z.infer<typeof outboundPartSchema>;

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

export async function startMcpServer(
  config: BridgeConfig,
  onebot: OneBotClient,
  store: MessageStore,
  astral: AstralAppServerClient,
): Promise<void> {
  if (config.mcp.transport === "http") {
    await startHttpMcpServer(config, onebot, store, astral);
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
    writeJson(res, 200, dashboardState(config, onebot, astral, store, externalEventBatcher));
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
