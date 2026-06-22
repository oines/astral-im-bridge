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

interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

interface CompactStatus {
  running: boolean;
  turnId: string | null;
  itemId: string | null;
  startedAtMs: number | null;
}

export interface InterruptActiveTurnResult {
  interrupted: boolean;
  turnId: string | null;
}

export class AstralAppServerClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private connectPromise: Promise<void> | null = null;
  private submissionQueue: Promise<void> = Promise.resolve();
  private resumed = false;
  private activeTurnId: string | null = null;
  private modelSettingsSynced = false;
  private tokenUsage: ThreadTokenUsage | null = null;
  private compactStatus: CompactStatus = idleCompactStatus();

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

  async interruptActiveTurn(): Promise<InterruptActiveTurnResult> {
    await this.ensureThread();
    await this.refreshActiveTurn();

    const turnId = this.activeTurnId;
    if (!turnId) {
      return { interrupted: false, turnId: null };
    }

    await this.request("turn/interrupt", {
      threadId: this.config.threadId,
      turnId,
    });
    if (this.activeTurnId === turnId) {
      this.activeTurnId = null;
    }
    log("interrupted astral turn", {
      threadId: this.config.threadId,
      turnId,
    });
    return { interrupted: true, turnId };
  }

  async warmup(): Promise<void> {
    await this.ensureThread();
  }

  status(): Record<string, unknown> {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      resumed: this.resumed,
      activeTurnId: this.activeTurnId,
      pendingRequests: this.pending.size,
      threadId: this.config.threadId,
      modelProvider: this.config.modelProvider,
      model: this.config.model,
      modelSettingsSynced: this.modelSettingsSynced,
      tokenUsage: this.tokenUsage,
      contextWindow: contextWindowStatus(this.tokenUsage),
      cacheHitRate: cacheHitRateStatus(this.tokenUsage),
      compact: { ...this.compactStatus },
    };
  }

  private async submitInboundMessageNow(message: StoredMessage): Promise<void> {
    await this.ensureThread();
    const input = this.buildInput(buildAstralPrompt(message), message.attachments);
    const clientUserMessageId = `${message.platform}:${message.sourceType}:${message.targetId}:${message.platformMessageId}`;
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
      ...this.modelSettingsParams(),
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
      this.modelSettingsSynced = !this.hasModelSettings();
      return;
    }
    this.resumed = true;
    await this.refreshActiveTurn();
    await this.syncThreadModelSettings();
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

  private modelSettingsParams(): Record<string, string> {
    const params: Record<string, string> = {};
    if (this.config.modelProvider) {
      params.modelProvider = this.config.modelProvider;
    }
    if (this.config.model) {
      params.model = this.config.model;
    }
    return params;
  }

  private hasModelSettings(): boolean {
    return Boolean(this.config.modelProvider || this.config.model);
  }

  private async syncThreadModelSettings(): Promise<void> {
    if (this.modelSettingsSynced || !this.hasModelSettings()) {
      this.modelSettingsSynced = this.modelSettingsSynced || !this.hasModelSettings();
      return;
    }

    const modelSettings = this.modelSettingsParams();
    await this.request("thread/settings/update", {
      threadId: this.config.threadId,
      ...modelSettings,
    });
    this.modelSettingsSynced = true;
    this.activeTurnId = null;
    log("synced astral thread model settings", {
      threadId: this.config.threadId,
      ...modelSettings,
    });
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
      this.modelSettingsSynced = false;
      this.compactStatus = idleCompactStatus();
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

    this.handleNotification(message);
  }

  private handleNotification(message: unknown): void {
    if (!isRecord(message) || typeof message.method !== "string") {
      return;
    }
    const params = isRecord(message.params) ? message.params : null;
    if (!params || params.threadId !== this.config.threadId) {
      return;
    }

    switch (message.method) {
      case "thread/tokenUsage/updated": {
        const tokenUsage = normalizeThreadTokenUsage(params.tokenUsage);
        if (!tokenUsage) {
          warn("ignored malformed astral token usage notification");
          return;
        }
        this.tokenUsage = tokenUsage;
        return;
      }
      case "turn/started": {
        const turn = isRecord(params.turn) ? params.turn : null;
        const turnId = stringValue(turn?.id);
        if (turnId) {
          this.activeTurnId = turnId;
        }
        return;
      }
      case "turn/completed": {
        const turn = isRecord(params.turn) ? params.turn : null;
        const turnId = stringValue(turn?.id) ?? stringValue(params.turnId);
        if (turnId && turnId === this.activeTurnId) {
          this.activeTurnId = null;
        }
        if (turnId && turnId === this.compactStatus.turnId) {
          this.compactStatus = idleCompactStatus();
        }
        return;
      }
      case "item/started": {
        const item = isRecord(params.item) ? params.item : null;
        if (item?.type === "contextCompaction") {
          this.compactStatus = {
            running: true,
            turnId: stringValue(params.turnId),
            itemId: stringValue(item.id),
            startedAtMs: numberValue(params.startedAtMs) ?? null,
          };
        }
        return;
      }
      case "item/completed": {
        const item = isRecord(params.item) ? params.item : null;
        if (item?.type === "contextCompaction") {
          this.compactStatus = idleCompactStatus();
        }
        return;
      }
      case "thread/compacted":
        this.compactStatus = idleCompactStatus();
        return;
      default:
        return;
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

function idleCompactStatus(): CompactStatus {
  return {
    running: false,
    turnId: null,
    itemId: null,
    startedAtMs: null,
  };
}

function contextWindowStatus(usage: ThreadTokenUsage | null): Record<string, unknown> | null {
  if (!usage) {
    return null;
  }
  const usedTokens = Math.max(0, usage.last.totalTokens);
  const windowTokens =
    usage.modelContextWindow !== null && usage.modelContextWindow > 0
      ? usage.modelContextWindow
      : null;
  const remainingTokens = windowTokens === null ? null : Math.max(0, windowTokens - usedTokens);
  const usedPercent =
    windowTokens === null ? null : clampPercent(Math.round((usedTokens / windowTokens) * 100));
  return {
    usedTokens,
    windowTokens,
    remainingTokens,
    usedPercent,
  };
}

function cacheHitRateStatus(usage: ThreadTokenUsage | null): Record<string, unknown> | null {
  if (!usage) {
    return null;
  }
  const inputTokens = Math.max(0, usage.total.inputTokens);
  if (inputTokens === 0) {
    return null;
  }
  const cachedInputTokens = Math.min(Math.max(0, usage.total.cachedInputTokens), inputTokens);
  const percent = Math.floor((cachedInputTokens * 100 + Math.floor(inputTokens / 2)) / inputTokens);
  return {
    percent: clampPercent(percent),
    cachedInputTokens,
    inputTokens,
  };
}

function normalizeThreadTokenUsage(value: unknown): ThreadTokenUsage | null {
  if (!isRecord(value)) {
    return null;
  }
  const total = normalizeTokenUsageBreakdown(value.total);
  const last = normalizeTokenUsageBreakdown(value.last);
  const modelContextWindow =
    value.modelContextWindow === null ? null : numberValue(value.modelContextWindow);
  if (!total || !last || modelContextWindow === undefined) {
    return null;
  }
  return {
    total,
    last,
    modelContextWindow,
  };
}

function normalizeTokenUsageBreakdown(value: unknown): TokenUsageBreakdown | null {
  if (!isRecord(value)) {
    return null;
  }
  const totalTokens = numberValue(value.totalTokens);
  const inputTokens = numberValue(value.inputTokens);
  const cachedInputTokens = numberValue(value.cachedInputTokens);
  const outputTokens = numberValue(value.outputTokens);
  const reasoningOutputTokens = numberValue(value.reasoningOutputTokens);
  if (
    totalTokens === undefined ||
    inputTokens === undefined ||
    cachedInputTokens === undefined ||
    outputTokens === undefined ||
    reasoningOutputTokens === undefined
  ) {
    return null;
  }
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
