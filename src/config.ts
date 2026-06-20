import fs from "node:fs";
import path from "node:path";
import type { BridgeConfig } from "./types.js";

const defaultConfig: BridgeConfig = {
  onebot: {
    host: "127.0.0.1",
    port: 6701,
    path: "/onebot/v11/ws",
    accessToken: null,
    actionTimeoutMs: 10_000,
  },
  telegram: {
    enabled: false,
    botToken: "",
    botUsername: "",
    allowedChatIds: [],
    alwaysTriggerChatIds: [],
    triggerKeywords: [],
    recordUntriggered: true,
    pollTimeoutSeconds: 25,
    pollIntervalMs: 1_000,
    apiBaseUrl: "https://api.telegram.org",
  },
  mcp: {
    transport: "stdio",
    host: "127.0.0.1",
    port: 6710,
    path: "/mcp",
  },
  astral: {
    appServerUrl: "ws://127.0.0.1:4222",
    authToken: null,
    threadId: "",
    cwd: null,
    model: null,
    includeImageInputs: true,
  },
  qq: {
    botUserId: "",
    allowedGroupIds: [],
    alwaysTriggerGroupIds: [],
    allowedPrivateUserIds: [],
    triggerKeywords: [],
    recordUntriggered: true,
  },
  externalEvents: {
    enabled: true,
    path: "/api/events",
    authToken: null,
    maxBodyBytes: 64 * 1024,
    debounceMs: 2_000,
    maxBatchEvents: 20,
    maxBatchBodyChars: 6_000,
  },
  storage: {
    dbPath: "./data/astral-bridge.db",
    mediaDir: "./media",
    downloadMedia: false,
  },
};

export function loadConfig(argv = process.argv.slice(2)): BridgeConfig {
  const configPath = readConfigPath(argv);
  const fileConfig = configPath ? readJsonConfig(configPath) : {};
  const config = mergeConfig(defaultConfig, fileConfig);
  applyEnvOverrides(config);
  validateConfig(config);
  absolutizePaths(config, configPath ? path.dirname(path.resolve(configPath)) : process.cwd());
  return config;
}

function readConfigPath(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config" || arg === "-c") {
      return argv[index + 1] ?? null;
    }
    if (arg.startsWith("--config=")) {
      return arg.slice("--config=".length);
    }
  }
  return process.env.ASTRAL_BRIDGE_CONFIG ?? null;
}

function readJsonConfig(configPath: string): Partial<BridgeConfig> {
  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw) as Partial<BridgeConfig>;
}

function mergeConfig(base: BridgeConfig, patch: Partial<BridgeConfig>): BridgeConfig {
  return {
    onebot: { ...base.onebot, ...patch.onebot },
    telegram: { ...base.telegram, ...patch.telegram },
    mcp: { ...base.mcp, ...patch.mcp },
    astral: { ...base.astral, ...patch.astral },
    qq: { ...base.qq, ...patch.qq },
    externalEvents: { ...base.externalEvents, ...patch.externalEvents },
    storage: { ...base.storage, ...patch.storage },
  };
}

function applyEnvOverrides(config: BridgeConfig): void {
  config.astral.appServerUrl =
    process.env.ASTRAL_BRIDGE_APP_SERVER_URL ?? config.astral.appServerUrl;
  config.astral.threadId = process.env.ASTRAL_BRIDGE_THREAD_ID ?? config.astral.threadId;
  config.astral.authToken = process.env.ASTRAL_BRIDGE_APP_SERVER_AUTH_TOKEN ?? config.astral.authToken;
  config.qq.botUserId = process.env.ASTRAL_BRIDGE_BOT_QQ ?? config.qq.botUserId;
  config.qq.allowedGroupIds = envList("ASTRAL_BRIDGE_ALLOWED_GROUP_IDS") ?? config.qq.allowedGroupIds;
  config.qq.alwaysTriggerGroupIds =
    envList("ASTRAL_BRIDGE_ALWAYS_TRIGGER_GROUP_IDS") ?? config.qq.alwaysTriggerGroupIds;
  config.qq.allowedPrivateUserIds =
    envList("ASTRAL_BRIDGE_ALLOWED_PRIVATE_USER_IDS") ?? config.qq.allowedPrivateUserIds;
  config.qq.triggerKeywords =
    envList("ASTRAL_BRIDGE_TRIGGER_KEYWORDS") ?? config.qq.triggerKeywords;
  config.telegram.enabled =
    parseBoolean(process.env.ASTRAL_BRIDGE_TELEGRAM_ENABLED) ?? config.telegram.enabled;
  config.telegram.botToken =
    process.env.ASTRAL_BRIDGE_TELEGRAM_BOT_TOKEN ?? config.telegram.botToken;
  config.telegram.botUsername =
    process.env.ASTRAL_BRIDGE_TELEGRAM_BOT_USERNAME ?? config.telegram.botUsername;
  config.telegram.allowedChatIds =
    envList("ASTRAL_BRIDGE_TELEGRAM_ALLOWED_CHAT_IDS") ?? config.telegram.allowedChatIds;
  config.telegram.alwaysTriggerChatIds =
    envList("ASTRAL_BRIDGE_TELEGRAM_ALWAYS_TRIGGER_CHAT_IDS") ?? config.telegram.alwaysTriggerChatIds;
  config.telegram.triggerKeywords =
    envList("ASTRAL_BRIDGE_TELEGRAM_TRIGGER_KEYWORDS") ?? config.telegram.triggerKeywords;
  config.telegram.recordUntriggered =
    parseBoolean(process.env.ASTRAL_BRIDGE_TELEGRAM_RECORD_UNTRIGGERED)
    ?? config.telegram.recordUntriggered;
  config.telegram.pollTimeoutSeconds =
    parsePositiveInteger(process.env.ASTRAL_BRIDGE_TELEGRAM_POLL_TIMEOUT_SECONDS)
    ?? config.telegram.pollTimeoutSeconds;
  config.telegram.pollIntervalMs =
    parsePositiveInteger(process.env.ASTRAL_BRIDGE_TELEGRAM_POLL_INTERVAL_MS)
    ?? config.telegram.pollIntervalMs;
  config.telegram.apiBaseUrl =
    process.env.ASTRAL_BRIDGE_TELEGRAM_API_BASE_URL ?? config.telegram.apiBaseUrl;
  config.mcp.transport = parseMcpTransport(process.env.ASTRAL_BRIDGE_MCP_TRANSPORT) ?? config.mcp.transport;
  config.externalEvents.enabled =
    parseBoolean(process.env.ASTRAL_BRIDGE_EVENT_API_ENABLED) ?? config.externalEvents.enabled;
  config.externalEvents.path = process.env.ASTRAL_BRIDGE_EVENT_API_PATH ?? config.externalEvents.path;
  config.externalEvents.authToken =
    process.env.ASTRAL_BRIDGE_EVENT_API_TOKEN ?? config.externalEvents.authToken;
  config.externalEvents.debounceMs =
    parsePositiveInteger(process.env.ASTRAL_BRIDGE_EVENT_API_DEBOUNCE_MS) ?? config.externalEvents.debounceMs;
  config.externalEvents.maxBatchEvents =
    parsePositiveInteger(process.env.ASTRAL_BRIDGE_EVENT_API_MAX_BATCH_EVENTS)
    ?? config.externalEvents.maxBatchEvents;
  config.externalEvents.maxBatchBodyChars =
    parsePositiveInteger(process.env.ASTRAL_BRIDGE_EVENT_API_MAX_BATCH_BODY_CHARS)
    ?? config.externalEvents.maxBatchBodyChars;
}

function validateConfig(config: BridgeConfig): void {
  if (!config.astral.threadId.trim()) {
    throw new Error("astral.threadId is required");
  }
  if (!config.qq.botUserId.trim()) {
    throw new Error("qq.botUserId is required");
  }
  if (!Number.isInteger(config.onebot.port) || config.onebot.port <= 0) {
    throw new Error("onebot.port must be a positive integer");
  }
  if (config.telegram.enabled && !config.telegram.botToken.trim()) {
    throw new Error("telegram.botToken is required when telegram.enabled is true");
  }
  if (!Number.isInteger(config.telegram.pollTimeoutSeconds) || config.telegram.pollTimeoutSeconds <= 0) {
    throw new Error("telegram.pollTimeoutSeconds must be a positive integer");
  }
  if (!Number.isInteger(config.telegram.pollIntervalMs) || config.telegram.pollIntervalMs <= 0) {
    throw new Error("telegram.pollIntervalMs must be a positive integer");
  }
  if (!config.telegram.apiBaseUrl.startsWith("http://") && !config.telegram.apiBaseUrl.startsWith("https://")) {
    throw new Error("telegram.apiBaseUrl must be an http(s) URL");
  }
  if (!Number.isInteger(config.mcp.port) || config.mcp.port <= 0) {
    throw new Error("mcp.port must be a positive integer");
  }
  if (!config.mcp.path.startsWith("/")) {
    throw new Error("mcp.path must start with /");
  }
  if (!config.externalEvents.path.startsWith("/")) {
    throw new Error("externalEvents.path must start with /");
  }
  if (!Number.isInteger(config.externalEvents.maxBodyBytes) || config.externalEvents.maxBodyBytes <= 0) {
    throw new Error("externalEvents.maxBodyBytes must be a positive integer");
  }
  if (!Number.isInteger(config.externalEvents.debounceMs) || config.externalEvents.debounceMs <= 0) {
    throw new Error("externalEvents.debounceMs must be a positive integer");
  }
  if (!Number.isInteger(config.externalEvents.maxBatchEvents) || config.externalEvents.maxBatchEvents <= 0) {
    throw new Error("externalEvents.maxBatchEvents must be a positive integer");
  }
  if (
    !Number.isInteger(config.externalEvents.maxBatchBodyChars)
    || config.externalEvents.maxBatchBodyChars <= 0
  ) {
    throw new Error("externalEvents.maxBatchBodyChars must be a positive integer");
  }
  config.qq.allowedGroupIds = normalizeIdList(config.qq.allowedGroupIds);
  config.qq.alwaysTriggerGroupIds = normalizeIdList(config.qq.alwaysTriggerGroupIds);
  config.qq.allowedPrivateUserIds = normalizeIdList(config.qq.allowedPrivateUserIds);
  config.qq.triggerKeywords = normalizeIdList(config.qq.triggerKeywords);
  config.qq.botUserId = String(config.qq.botUserId);
  config.telegram.allowedChatIds = normalizeIdList(config.telegram.allowedChatIds);
  config.telegram.alwaysTriggerChatIds = normalizeIdList(config.telegram.alwaysTriggerChatIds);
  config.telegram.triggerKeywords = normalizeIdList(config.telegram.triggerKeywords);
  config.telegram.botToken = String(config.telegram.botToken);
  config.telegram.botUsername = String(config.telegram.botUsername).replace(/^@/, "");
  config.telegram.apiBaseUrl = config.telegram.apiBaseUrl.replace(/\/+$/, "");
}

function envList(name: string): string[] | null {
  const value = process.env[name];
  if (!value) {
    return null;
  }
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function parseMcpTransport(value: string | undefined): "stdio" | "http" | null {
  if (value === "stdio" || value === "http") {
    return value;
  }
  return null;
}

function parseBoolean(value: string | undefined): boolean | null {
  if (value == null || value.trim() === "") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (value == null || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function normalizeIdList(values: string[]): string[] {
  return values.map(String).map((value) => value.trim()).filter(Boolean);
}

function absolutizePaths(config: BridgeConfig, baseDir: string): void {
  config.storage.dbPath = path.resolve(baseDir, config.storage.dbPath);
  config.storage.mediaDir = path.resolve(baseDir, config.storage.mediaDir);
}
