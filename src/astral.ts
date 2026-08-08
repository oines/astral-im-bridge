import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import WebSocket from "ws";
import { error, log, warn } from "./logger.js";
import type { AstralConfig, ExternalEvent, StoredMessage } from "./types.js";
import { buildAstralPrompt, buildExternalEventPrompt } from "./message.js";
import type { MessageStore } from "./store.js";

type RequestId = string;
type ThreadIdSource = "config" | "store_auto" | "created_auto" | "none";

const AUTO_THREAD_ID_META_KEY = "astral_thread_id";
const THREAD_HISTORY_META_KEY = "astral_thread_history";
const THREAD_HISTORY_LIMIT = 20;

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

interface ModelSettings {
  modelProvider: string | null;
  model: string | null;
  reasoningEffort: string | null;
  source: "astral_config" | "bridge_config" | "none";
  path: string | null;
  error: string | null;
}

export interface InterruptActiveTurnResult {
  interrupted: boolean;
  turnId: string | null;
}

export interface RotateThreadResult {
  rotated: boolean;
  threadId: string | null;
  previousThreadId: string | null;
  threadIdSource: ThreadIdSource;
  activeTurnId: string | null;
  reason: string;
}

export interface AstralDashboardEvent {
  method: string;
  params: Record<string, unknown>;
  emittedAt: string;
}

export class AstralAppServerClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private connectPromise: Promise<void> | null = null;
  private submissionQueue: Promise<void> = Promise.resolve();
  private resumed = false;
  private canUpdateThreadSettings = false;
  private activeTurnId: string | null = null;
  private modelSettingsSynced = false;
  private syncedModelSettingsKey: string | null = null;
  private modelSettingsStatus: ModelSettings = emptyModelSettings("none");
  private tokenUsage: ThreadTokenUsage | null = null;
  private compactStatus: CompactStatus = idleCompactStatus();
  private resolvedThreadId: string | null = null;
  private threadIdSource: ThreadIdSource = "none";
  private rotateThreadOnStartConsumed = false;

  constructor(
    private readonly config: AstralConfig,
    private readonly store: MessageStore,
  ) {
    super();
  }

  async submitInboundMessage(message: StoredMessage): Promise<void> {
    const dashboardInput = dashboardInputFromMessage(message);
    this.emitDashboardEvent("bridge/input/queued", dashboardInput);
    const task = this.submissionQueue.then(async () => {
      this.emitDashboardEvent("bridge/input/processing", dashboardInput);
      try {
        await this.submitInboundMessageNow(message);
        this.emitDashboardEvent("bridge/input/submitted", dashboardInput);
      } catch (err) {
        this.emitDashboardEvent("bridge/input/failed", {
          ...dashboardInput,
          error: errorMessage(err),
        });
        throw err;
      }
    });
    this.submissionQueue = task.catch(() => undefined);
    return task;
  }

  async submitExternalEvent(event: ExternalEvent): Promise<void> {
    const dashboardInput = dashboardInputFromExternalEvent(event);
    this.emitDashboardEvent("bridge/input/queued", dashboardInput);
    const task = this.submissionQueue.then(async () => {
      this.emitDashboardEvent("bridge/input/processing", dashboardInput);
      try {
        await this.submitExternalEventNow(event);
        this.emitDashboardEvent("bridge/input/submitted", dashboardInput);
      } catch (err) {
        this.emitDashboardEvent("bridge/input/failed", {
          ...dashboardInput,
          error: errorMessage(err),
        });
        throw err;
      }
    });
    this.submissionQueue = task.catch(() => undefined);
    return task;
  }

  subscribeDashboardEvents(listener: (event: AstralDashboardEvent) => void): () => void {
    this.on("dashboardEvent", listener);
    return () => this.off("dashboardEvent", listener);
  }

  async interruptActiveTurn(): Promise<InterruptActiveTurnResult> {
    await this.ensureThread();
    await this.refreshActiveTurn();
    const threadId = this.currentThreadId();

    const turnId = this.activeTurnId;
    if (!turnId) {
      return { interrupted: false, turnId: null };
    }

    await this.request("turn/interrupt", {
      threadId,
      turnId,
    });
    if (this.activeTurnId === turnId) {
      this.activeTurnId = null;
    }
    log("interrupted astral turn", {
      threadId,
      turnId,
    });
    return { interrupted: true, turnId };
  }

  async warmup(): Promise<void> {
    await this.ensureThread();
  }

  async rotateThread(reason = "manual"): Promise<RotateThreadResult> {
    if (this.config.threadId) {
      throw new Error("Astral thread is config-managed; clear astral.threadId to use auto thread rotation");
    }

    await this.ensureConnected();
    const storedThreadId = normalizeThreadId(this.store.getMetaValue(AUTO_THREAD_ID_META_KEY));
    if (!this.resolvedThreadId && storedThreadId) {
      this.resolvedThreadId = storedThreadId;
      this.threadIdSource = "store_auto";
    }
    if (this.resolvedThreadId) {
      await this.refreshActiveTurn();
    }
    if (this.activeTurnId) {
      return {
        rotated: false,
        threadId: this.resolvedThreadId,
        previousThreadId: this.resolvedThreadId,
        threadIdSource: this.threadIdSource,
        activeTurnId: this.activeTurnId,
        reason,
      };
    }

    const previousThreadId = this.resolvedThreadId ?? storedThreadId;
    const newThreadId = await this.createAutoThread(reason);
    this.store.setMetaValue(AUTO_THREAD_ID_META_KEY, newThreadId);
    this.recordThreadHistory(previousThreadId, newThreadId, reason);
    this.resolvedThreadId = newThreadId;
    this.threadIdSource = "created_auto";
    this.rotateThreadOnStartConsumed = true;
    this.resumed = true;
    this.activeTurnId = null;
    log("rotated astral auto thread", {
      previousThreadId,
      threadId: newThreadId,
      reason,
    });
    return {
      rotated: true,
      threadId: newThreadId,
      previousThreadId,
      threadIdSource: this.threadIdSource,
      activeTurnId: null,
      reason,
    };
  }

  status(): Record<string, unknown> {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      resumed: this.resumed,
      activeTurnId: this.activeTurnId,
      pendingRequests: this.pending.size,
      threadId: (this.resolvedThreadId ?? this.config.threadId) || null,
      configuredThreadId: this.config.threadId || null,
      threadIdSource: this.threadIdSource,
      autoThreadManaged: !this.config.threadId,
      rotateThreadOnStart: this.config.rotateThreadOnStart,
      modelProvider: this.modelSettingsStatus.modelProvider,
      model: this.modelSettingsStatus.model,
      reasoningEffort: this.modelSettingsStatus.reasoningEffort,
      modelSettingsSource: this.modelSettingsStatus.source,
      modelConfigPath: this.modelSettingsStatus.path ?? this.config.modelConfigPath,
      modelSettingsError: this.modelSettingsStatus.error,
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
    const threadId = this.currentThreadId();
    if (this.activeTurnId) {
      try {
        await this.request("turn/steer", {
          threadId,
          clientUserMessageId,
          input,
          expectedTurnId: this.activeTurnId,
        });
        log("steered active astral turn", {
          threadId,
          turnId: this.activeTurnId,
          messageId: logId,
        });
        return;
      } catch (err) {
        warn("turn/steer failed; falling back to turn/start", { error: String(err) });
        this.activeTurnId = null;
      }
    }

    const modelSettings = this.canUpdateThreadSettings
      ? await this.syncThreadModelSettings()
      : await this.resolveModelSettings();
    const response = await this.request<{ turn?: { id?: string } }>("turn/start", {
      threadId,
      clientUserMessageId,
      input,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      ...modelSettingsParams(modelSettings),
    });
    this.canUpdateThreadSettings = true;
    if (hasModelSettings(modelSettings)) {
      this.syncedModelSettingsKey = modelSettingsKey(modelSettings);
      this.modelSettingsSynced = true;
    } else {
      this.syncedModelSettingsKey = modelSettingsKey(modelSettings);
      this.modelSettingsSynced = modelSettings.error === null;
    }
    this.activeTurnId = response.turn?.id ?? null;
    log("started astral turn", {
      threadId,
      turnId: this.activeTurnId,
      messageId: logId,
    });
  }

  private async ensureThread(): Promise<void> {
    await this.ensureConnected();
    const threadId = await this.ensureResolvedThreadId();
    if (this.resumed) {
      return;
    }
    try {
      await this.request("thread/resume", {
        threadId,
        excludeTurns: true,
      });
    } catch (err) {
      if (!isMissingRolloutError(err)) {
        throw err;
      }
      warn("astral thread has no rollout yet; starting first turn without resume", {
        threadId,
        error: String(err),
      });
      this.resumed = true;
      this.canUpdateThreadSettings = false;
      this.modelSettingsSynced = false;
      return;
    }
    this.resumed = true;
    this.canUpdateThreadSettings = true;
    await this.refreshActiveTurn();
    await this.syncThreadModelSettings();
  }

  private async ensureResolvedThreadId(): Promise<string> {
    if (this.config.threadId) {
      this.resolvedThreadId = this.config.threadId;
      this.threadIdSource = "config";
      return this.config.threadId;
    }

    const shouldRotateOnStart = this.config.rotateThreadOnStart && !this.rotateThreadOnStartConsumed;
    if (this.resolvedThreadId && !shouldRotateOnStart) {
      return this.resolvedThreadId;
    }

    const storedThreadId = normalizeThreadId(this.store.getMetaValue(AUTO_THREAD_ID_META_KEY));
    if (storedThreadId && !shouldRotateOnStart) {
      this.resolvedThreadId = storedThreadId;
      this.threadIdSource = "store_auto";
      return storedThreadId;
    }

    const previousThreadId = this.resolvedThreadId ?? storedThreadId;
    const reason = shouldRotateOnStart ? "rotate_on_start" : "auto_onboarding";
    const newThreadId = await this.createAutoThread(reason);
    this.store.setMetaValue(AUTO_THREAD_ID_META_KEY, newThreadId);
    this.recordThreadHistory(previousThreadId, newThreadId, reason);
    this.resolvedThreadId = newThreadId;
    this.threadIdSource = "created_auto";
    this.rotateThreadOnStartConsumed = true;
    this.resumed = true;
    log("created astral auto thread", {
      previousThreadId,
      threadId: newThreadId,
      reason,
    });
    return newThreadId;
  }

  private async createAutoThread(reason: string): Promise<string> {
    const modelSettings = await this.resolveModelSettings();
    const response = await this.request<{ thread?: { id?: string } }>("thread/start", {
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: false,
      ...threadStartModelSettingsParams(modelSettings),
    });
    const threadId = response.thread?.id;
    if (!threadId) {
      throw new Error("thread/start did not return thread.id");
    }
    this.canUpdateThreadSettings = true;
    this.modelSettingsSynced = modelSettings.error === null && !modelSettings.reasoningEffort;
    this.syncedModelSettingsKey = this.modelSettingsSynced ? modelSettingsKey(modelSettings) : null;
    this.activeTurnId = null;
    log("started astral auto thread", {
      threadId,
      reason,
      modelProvider: modelSettings.modelProvider,
      model: modelSettings.model,
      reasoningEffort: modelSettings.reasoningEffort,
      source: modelSettings.source,
      path: modelSettings.path,
    });
    return threadId;
  }

  private currentThreadId(): string {
    const threadId = this.resolvedThreadId ?? this.config.threadId;
    if (!threadId) {
      throw new Error("Astral thread is not initialized");
    }
    return threadId;
  }

  private recordThreadHistory(
    previousThreadId: string | null,
    newThreadId: string,
    reason: string,
  ): void {
    if (!previousThreadId || previousThreadId === newThreadId) {
      return;
    }
    const raw = this.store.getMetaValue(THREAD_HISTORY_META_KEY);
    let history: Array<Record<string, unknown>> = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          history = parsed.filter(isRecord);
        }
      } catch (err) {
        warn("ignored malformed astral thread history", { error: String(err) });
      }
    }
    history.unshift({
      previousThreadId,
      newThreadId,
      reason,
      rotatedAt: new Date().toISOString(),
    });
    this.store.setMetaValue(THREAD_HISTORY_META_KEY, JSON.stringify(history.slice(0, THREAD_HISTORY_LIMIT)));
  }

  private async refreshActiveTurn(): Promise<void> {
    try {
      const threadId = this.currentThreadId();
      const response = await this.request<{ data?: Array<{ id: string; status: string }> }>(
        "thread/turns/list",
        {
          threadId,
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

  private async resolveModelSettings(): Promise<ModelSettings> {
    if (this.config.modelConfigPath) {
      const modelSettings = await this.resolveModelSettingsFromFile(this.config.modelConfigPath);
      this.modelSettingsStatus = modelSettings;
      return modelSettings;
    }

    const modelSettings = normalizeModelSettings({
      modelProvider: this.config.modelProvider,
      model: this.config.model,
      reasoningEffort: null,
      source: this.config.modelProvider || this.config.model ? "bridge_config" : "none",
      path: null,
      error: null,
    });
    this.modelSettingsStatus = modelSettings;
    return modelSettings;
  }

  private async resolveModelSettingsFromFile(modelConfigPath: string): Promise<ModelSettings> {
    try {
      const raw = await fs.readFile(modelConfigPath, "utf8");
      const parsed = parseAstralModelConfig(raw);
      return normalizeModelSettings({
        modelProvider: parsed.modelProvider,
        model: parsed.model,
        reasoningEffort: parsed.reasoningEffort,
        source: "astral_config",
        path: modelConfigPath,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn("failed to read astral model config", {
        path: modelConfigPath,
        error: message,
      });
      return {
        modelProvider: null,
        model: null,
        reasoningEffort: null,
        source: "astral_config",
        path: modelConfigPath,
        error: message,
      };
    }
  }

  private async syncThreadModelSettings(): Promise<ModelSettings> {
    const modelSettings = await this.resolveModelSettings();
    const key = modelSettingsKey(modelSettings);
    if (!hasModelSettings(modelSettings)) {
      this.modelSettingsSynced = modelSettings.error === null;
      this.syncedModelSettingsKey = key;
      return modelSettings;
    }
    if (this.modelSettingsSynced && this.syncedModelSettingsKey === key) {
      return modelSettings;
    }

    const threadId = this.currentThreadId();
    await this.request("thread/settings/update", {
      threadId,
      ...modelSettingsParams(modelSettings),
    });
    this.syncedModelSettingsKey = key;
    this.modelSettingsSynced = true;
    log("synced astral thread model settings", {
      threadId,
      modelProvider: modelSettings.modelProvider,
      model: modelSettings.model,
      reasoningEffort: modelSettings.reasoningEffort,
      source: modelSettings.source,
      path: modelSettings.path,
    });
    return modelSettings;
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
      this.canUpdateThreadSettings = false;
      this.activeTurnId = null;
      this.modelSettingsSynced = false;
      this.syncedModelSettingsKey = null;
      this.modelSettingsStatus = emptyModelSettings("none");
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
    if (!params || params.threadId !== this.resolvedThreadId) {
      return;
    }

    this.emitDashboardEvent(message.method, params);

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

  private emitDashboardEvent(method: string, params: Record<string, unknown>): void {
    const event = {
      method,
      params,
      emittedAt: new Date().toISOString(),
    } satisfies AstralDashboardEvent;
    this.emit("dashboardEvent", event);
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

function dashboardInputFromMessage(message: StoredMessage): Record<string, unknown> {
  return {
    id: `${message.platform}:${message.sourceType}:${message.targetId}:${message.platformMessageId}`,
    kind: "message",
    platform: message.platform,
    sourceType: message.sourceType,
    targetId: message.targetId,
    groupName: message.groupName,
    userId: message.userId,
    sender: message.groupCard || message.nickname || message.userId,
    text: message.rawMessage || message.text,
    trigger: message.trigger,
    occurredAt: new Date(message.time * 1000).toISOString(),
    attachmentCount: message.attachments.length,
  };
}

function dashboardInputFromExternalEvent(event: ExternalEvent): Record<string, unknown> {
  return {
    id: `external:${event.source}:${event.id}`,
    kind: "external_event",
    platform: "external",
    sourceType: event.eventType,
    targetId: event.source,
    groupName: event.title,
    userId: null,
    sender: event.source,
    text: event.body,
    trigger: "external_event",
    occurredAt: event.occurredAt,
    attachmentCount: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function emptyModelSettings(source: ModelSettings["source"]): ModelSettings {
  return {
    modelProvider: null,
    model: null,
    reasoningEffort: null,
    source,
    path: null,
    error: null,
  };
}

function normalizeModelSettings(settings: ModelSettings): ModelSettings {
  return {
    ...settings,
    modelProvider: normalizeOptionalText(settings.modelProvider),
    model: normalizeOptionalText(settings.model),
    reasoningEffort: normalizeOptionalText(settings.reasoningEffort),
  };
}

function hasModelSettings(settings: ModelSettings): boolean {
  return Boolean(settings.modelProvider || settings.model || settings.reasoningEffort);
}

function modelSettingsParams(settings: ModelSettings): Record<string, string> {
  const params: Record<string, string> = {};
  if (settings.modelProvider) {
    params.modelProvider = settings.modelProvider;
  }
  if (settings.model) {
    params.model = settings.model;
  }
  if (settings.reasoningEffort) {
    params.effort = settings.reasoningEffort;
  }
  return params;
}

function threadStartModelSettingsParams(settings: ModelSettings): Record<string, string> {
  const params: Record<string, string> = {};
  if (settings.modelProvider) {
    params.modelProvider = settings.modelProvider;
  }
  if (settings.model) {
    params.model = settings.model;
  }
  return params;
}

function modelSettingsKey(settings: ModelSettings): string {
  return JSON.stringify({
    modelProvider: settings.modelProvider,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    source: settings.source,
    path: settings.path,
    error: settings.error,
  });
}

function parseAstralModelConfig(raw: string): {
  modelProvider: string | null;
  model: string | null;
  reasoningEffort: string | null;
} {
  let modelProvider: string | null = null;
  let model: string | null = null;
  let reasoningEffort: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = stripTomlComment(line).trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("[")) {
      break;
    }
    const match = /^(model_provider|model_reasoning_effort|model)\s*=\s*(.+)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    const value = parseTomlScalarString(match[2]);
    if (match[1] === "model_provider") {
      modelProvider = value;
    } else if (match[1] === "model_reasoning_effort") {
      reasoningEffort = value;
    } else {
      model = value;
    }
  }

  return {
    modelProvider: normalizeOptionalText(modelProvider),
    model: normalizeOptionalText(model),
    reasoningEffort: normalizeOptionalText(reasoningEffort),
  };
}

function stripTomlComment(line: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inDoubleQuote && char === "\\") {
      escaped = true;
      continue;
    }
    if (!inDoubleQuote && char === "'") {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (!inSingleQuote && char === "\"") {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && char === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseTomlScalarString(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("\"")) {
    const endIndex = findTomlDoubleQuoteEnd(trimmed);
    if (endIndex > 0) {
      try {
        return JSON.parse(trimmed.slice(0, endIndex + 1)) as string;
      } catch {
        return trimmed.slice(1, endIndex);
      }
    }
  }
  if (trimmed.startsWith("'")) {
    const endIndex = trimmed.indexOf("'", 1);
    if (endIndex > 0) {
      return trimmed.slice(1, endIndex);
    }
  }
  return trimmed;
}

function findTomlDoubleQuoteEnd(value: string): number {
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      return index;
    }
  }
  return -1;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
}

function normalizeThreadId(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized : null;
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
