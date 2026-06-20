import { EventEmitter } from "node:events";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { error, log, warn } from "./logger.js";
import type { GroupInfo, OneBotConfig, OneBotMessageEvent, OneBotPokeNoticeEvent } from "./types.js";

interface PendingAction {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface OneBotEvents {
  message: [OneBotMessageEvent];
  poke: [OneBotPokeNoticeEvent];
  connected: [];
  disconnected: [];
}

export class OneBotClient extends EventEmitter<OneBotEvents> {
  private readonly pending = new Map<string, PendingAction>();
  private readonly groupInfoCache = new Map<string, GroupInfo>();
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;

  constructor(private readonly config: OneBotConfig) {
    super();
  }

  async start(): Promise<void> {
    this.server = http.createServer();
    this.wss = new WebSocketServer({ noServer: true });

    this.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname !== this.config.path) {
        socket.destroy();
        return;
      }
      if (!this.isAuthorized(request, url)) {
        socket.destroy();
        return;
      }
      this.wss?.handleUpgrade(request, socket, head, (ws) => {
        this.wss?.emit("connection", ws, request);
      });
    });

    this.wss.on("connection", (ws) => {
      this.replaceSocket(ws);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.config.port, this.config.host, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });

    log("onebot reverse websocket listening", {
      host: this.config.host,
      port: this.config.port,
      path: this.config.path,
    });
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("OneBot client stopped"));
    }
    this.pending.clear();
    this.socket?.close();
    await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  async callAction<T = unknown>(
    action: string,
    params: Record<string, unknown>,
    timeoutMs = this.config.actionTimeoutMs,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) {
      throw new Error("NapCat OneBot websocket is not connected");
    }

    const echo = randomUUID();
    const payload = JSON.stringify({ action, params, echo });
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot action timed out: ${action}`));
      }, timeoutMs);
      this.pending.set(echo, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
    socket.send(payload);
    return promise;
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo> {
    const cached = this.groupInfoCache.get(groupId);
    if (cached) {
      return cached;
    }
    const response = await this.callAction<{ data?: Record<string, unknown> }>("get_group_info", {
      group_id: Number(groupId),
      no_cache: false,
    });
    const data = response.data ?? {};
    const info: GroupInfo = {
      group_id: String(data.group_id ?? groupId),
      group_name: data.group_name == null ? null : String(data.group_name),
      member_count: asNullableNumber(data.member_count),
      max_member_count: asNullableNumber(data.max_member_count),
    };
    this.groupInfoCache.set(groupId, info);
    return info;
  }

  async getMessage(messageId: string): Promise<OneBotMessageEvent | null> {
    const response = await this.callAction<{ data?: unknown }>("get_msg", {
      message_id: Number.isNaN(Number(messageId)) ? messageId : Number(messageId),
    });
    return (response.data ?? null) as OneBotMessageEvent | null;
  }

  status(): Record<string, unknown> {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      pendingActions: this.pending.size,
      cachedGroups: this.groupInfoCache.size,
    };
  }

  private replaceSocket(ws: WebSocket): void {
    if (this.socket && this.socket.readyState === this.socket.OPEN) {
      this.socket.close();
    }
    this.socket = ws;
    log("napcat connected");
    this.emit("connected");

    ws.on("message", (data) => this.handleMessage(data));
    ws.on("close", () => {
      if (this.socket === ws) {
        this.socket = null;
      }
      warn("napcat disconnected");
      this.emit("disconnected");
    });
    ws.on("error", (err) => {
      error("napcat websocket error", { error: String(err) });
    });
  }

  private handleMessage(data: RawData): void {
    let payload: unknown;
    try {
      payload = JSON.parse(data.toString());
    } catch (err) {
      warn("ignored non-json onebot payload", { error: String(err) });
      return;
    }

    if (isActionResponse(payload)) {
      const pending = this.pending.get(payload.echo);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(payload.echo);
        pending.resolve(payload);
      }
      return;
    }

    if (isMessageEvent(payload)) {
      log("onebot message event received", {
        postType: payload.post_type,
        messageType: payload.message_type,
        messageId: payload.message_id,
        groupId: payload.group_id,
        userId: payload.user_id,
      });
      this.emit("message", payload);
      return;
    }

    if (isPokeNoticeEvent(payload)) {
      log("onebot poke notice received", {
        groupId: payload.group_id,
        userId: payload.user_id,
        targetId: payload.target_id,
      });
      this.emit("poke", payload);
      return;
    }

    if (typeof payload === "object" && payload !== null && "post_type" in payload) {
      const event = payload as Record<string, unknown>;
      log("ignored onebot event", {
        postType: event.post_type,
        messageType: event.message_type,
        messageId: event.message_id,
        metaEventType: event.meta_event_type,
        noticeType: event.notice_type,
      });
    }
  }

  private isAuthorized(request: http.IncomingMessage, url: URL): boolean {
    const token = this.config.accessToken;
    if (!token) {
      return true;
    }
    const queryToken = url.searchParams.get("access_token");
    const auth = request.headers.authorization;
    return queryToken === token || auth === `Bearer ${token}`;
  }
}

function isActionResponse(value: unknown): value is { echo: string } {
  return typeof value === "object" && value !== null && "echo" in value;
}

function isMessageEvent(value: unknown): value is OneBotMessageEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const event = value as Record<string, unknown>;
  return (
    (event.post_type === "message" || event.post_type === "message_sent") &&
    (event.message_type === "group" || event.message_type === "private") &&
    event.message_id != null
  );
}

function isPokeNoticeEvent(value: unknown): value is OneBotPokeNoticeEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const event = value as Record<string, unknown>;
  return (
    event.post_type === "notice" &&
    event.notice_type === "notify" &&
    event.sub_type === "poke" &&
    event.user_id != null &&
    event.target_id != null
  );
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
