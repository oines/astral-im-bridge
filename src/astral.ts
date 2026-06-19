import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { error, log, warn } from "./logger.js";
import type { AstralConfig, ExternalEvent, StoredMessage } from "./types.js";
import { buildAstralPrompt, buildExternalEventPrompt } from "./message.js";

type RequestId = string;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class AstralAppServerClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private connectPromise: Promise<void> | null = null;
  private submissionQueue: Promise<void> = Promise.resolve();
  private resumed = false;
  private activeTurnId: string | null = null;

  constructor(private readonly config: AstralConfig) {
    super();
  }

  async submitInboundMessage(message: StoredMessage): Promise<void> {
    const task = this.submissionQueue.then(() => this.submitInboundMessageNow(message));
    this.submissionQueue = task.catch(() => undefined);
    return task;
  }

  async submitExternalEvent(event: ExternalEvent): Promise<void> {
    const task = this.submissionQueue.then(() => this.submitExternalEventNow(event));
    this.submissionQueue = task.catch(() => undefined);
    return task;
  }

  status(): Record<string, unknown> {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      resumed: this.resumed,
      activeTurnId: this.activeTurnId,
      pendingRequests: this.pending.size,
      threadId: this.config.threadId,
    };
  }

  private async submitInboundMessageNow(message: StoredMessage): Promise<void> {
    await this.ensureThread();
    const input = this.buildInput(buildAstralPrompt(message), message.attachments);
    const clientUserMessageId = `qq:${message.sourceType}:${message.targetId}:${message.platformMessageId}`;
    await this.submitInput(clientUserMessageId, input, message.platformMessageId);
  }

  private async submitExternalEventNow(event: ExternalEvent): Promise<void> {
    await this.ensureThread();
    const input = this.buildInput(buildExternalEventPrompt(event), []);
    const clientUserMessageId = `external:${event.source}:${event.id}`;
    await this.submitInput(clientUserMessageId, input, event.id);
  }

  private async submitInput(
    clientUserMessageId: string,
    input: Array<Record<string, unknown>>,
    logId: string,
  ): Promise<void> {
    if (this.activeTurnId) {
      try {
        await this.request("turn/steer", {
          threadId: this.config.threadId,
          clientUserMessageId,
          input,
          expectedTurnId: this.activeTurnId,
        });
        log("steered active astral turn", {
          threadId: this.config.threadId,
          turnId: this.activeTurnId,
          messageId: logId,
        });
        return;
      } catch (err) {
        warn("turn/steer failed; falling back to turn/start", { error: String(err) });
        this.activeTurnId = null;
      }
    }

    const response = await this.request<{ turn?: { id?: string } }>("turn/start", {
      threadId: this.config.threadId,
      clientUserMessageId,
      input,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      ...(this.config.model ? { model: this.config.model } : {}),
    });
    this.activeTurnId = response.turn?.id ?? null;
    log("started astral turn", {
      threadId: this.config.threadId,
      turnId: this.activeTurnId,
      messageId: logId,
    });
  }

  private async ensureThread(): Promise<void> {
    await this.ensureConnected();
    if (this.resumed) {
      return;
    }
    try {
      await this.request("thread/resume", {
        threadId: this.config.threadId,
        excludeTurns: true,
      });
    } catch (err) {
      if (!isMissingRolloutError(err)) {
        throw err;
      }
      warn("fixed astral thread has no rollout yet; starting first turn without resume", {
        threadId: this.config.threadId,
        error: String(err),
      });
      this.resumed = true;
      return;
    }
    this.resumed = true;
    await this.refreshActiveTurn();
  }

  private async refreshActiveTurn(): Promise<void> {
    try {
      const response = await this.request<{ data?: Array<{ id: string; status: string }> }>(
        "thread/turns/list",
        {
          threadId: this.config.threadId,
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        },
      );
      const latest = response.data?.[0];
      this.activeTurnId = latest?.status === "inProgress" ? latest.id : null;
    } catch (err) {
      warn("failed to refresh active turn state", { error: String(err) });
    }
  }

  private buildInput(
    prompt: string,
    attachments: StoredMessage["attachments"],
  ): Array<Record<string, unknown>> {
    const input: Array<Record<string, unknown>> = [
      {
        type: "text",
        text: prompt,
        textElements: [],
      },
    ];

    if (this.config.includeImageInputs) {
      for (const attachment of attachments) {
        if (attachment.kind === "image" && attachment.url) {
          input.push({
            type: "image",
            url: attachment.url,
          });
        }
      }
    }

    return input;
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.connect().finally(() => {
        this.connectPromise = null;
      });
    }
    await this.connectPromise;
  }

  private async connect(): Promise<void> {
    const headers = this.config.authToken
      ? { Authorization: `Bearer ${this.config.authToken}` }
      : undefined;
    const socket = new WebSocket(this.config.appServerUrl, { headers });
    this.socket = socket;

    socket.on("message", (data) => this.handleMessage(data.toString()));
    socket.on("close", () => {
      this.socket = null;
      this.resumed = false;
      this.activeTurnId = null;
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Astral app-server websocket closed"));
      }
      this.pending.clear();
      warn("astral app-server disconnected");
    });
    socket.on("error", (err) => {
      error("astral app-server websocket error", { error: String(err) });
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "astral-bridge",
        title: "Astral QQ IM Bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    this.notify("initialized");
    log("astral app-server connected", { url: this.config.appServerUrl });
  }

  private async request<T = unknown>(method: string, params: unknown): Promise<T> {
    await this.ensureRawSocket();
    const id = `astral-bridge-${this.nextId}`;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.socket?.send(payload);
    return promise;
  }

  private notify(method: string, params?: unknown): void {
    const payload = params === undefined ? { method } : { method, params };
    this.socket?.send(JSON.stringify(payload));
  }

  private async ensureRawSocket(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    await this.ensureConnected();
  }

  private handleMessage(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch (err) {
      warn("ignored non-json astral payload", { error: String(err) });
      return;
    }

    if ("id" in message && "result" in message) {
      const pending = this.pending.get(String(message.id));
      if (pending) {
        this.pending.delete(String(message.id));
        pending.resolve(message.result);
      }
      return;
    }

    if ("id" in message && "error" in message) {
      const pending = this.pending.get(String(message.id));
      if (pending) {
        this.pending.delete(String(message.id));
        pending.reject(new Error(`${message.error?.message ?? "Astral app-server error"}`));
      }
      return;
    }

    if ("id" in message && "method" in message) {
      this.respondToServerRequest(message);
      return;
    }

    if (message.method === "turn/completed" && message.params?.threadId === this.config.threadId) {
      const turnId = message.params?.turn?.id;
      if (turnId && turnId === this.activeTurnId) {
        this.activeTurnId = null;
      }
    }
  }

  private respondToServerRequest(request: { id: RequestId; method: string }): void {
    const result = safeServerRequestResponse(request.method);
    if (result) {
      this.socket?.send(JSON.stringify({ id: request.id, result }));
      return;
    }
    this.socket?.send(
      JSON.stringify({
        id: request.id,
        error: {
          code: -32601,
          message: `astral-bridge does not handle server request ${request.method}`,
        },
      }),
    );
  }
}

function isMissingRolloutError(error: unknown): boolean {
  return String(error).includes("no rollout found for thread id");
}

function safeServerRequestResponse(method: string): Record<string, unknown> | null {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return { decision: "cancel" };
    case "item/fileChange/requestApproval":
      return { decision: "cancel" };
    case "mcpServer/elicitation/request":
      return { action: "cancel", content: null };
    default:
      return null;
  }
}
