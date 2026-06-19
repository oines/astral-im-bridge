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
    allowedPrivateUserIds: [],
    recordUntriggered: true,
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
    mcp: { ...base.mcp, ...patch.mcp },
    astral: { ...base.astral, ...patch.astral },
    qq: { ...base.qq, ...patch.qq },
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
  config.qq.allowedPrivateUserIds =
    envList("ASTRAL_BRIDGE_ALLOWED_PRIVATE_USER_IDS") ?? config.qq.allowedPrivateUserIds;
  config.mcp.transport = parseMcpTransport(process.env.ASTRAL_BRIDGE_MCP_TRANSPORT) ?? config.mcp.transport;
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
  if (!Number.isInteger(config.mcp.port) || config.mcp.port <= 0) {
    throw new Error("mcp.port must be a positive integer");
  }
  if (!config.mcp.path.startsWith("/")) {
    throw new Error("mcp.path must start with /");
  }
  config.qq.allowedGroupIds = normalizeIdList(config.qq.allowedGroupIds);
  config.qq.allowedPrivateUserIds = normalizeIdList(config.qq.allowedPrivateUserIds);
  config.qq.botUserId = String(config.qq.botUserId);
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

function normalizeIdList(values: string[]): string[] {
  return values.map(String).map((value) => value.trim()).filter(Boolean);
}

function absolutizePaths(config: BridgeConfig, baseDir: string): void {
  config.storage.dbPath = path.resolve(baseDir, config.storage.dbPath);
  config.storage.mediaDir = path.resolve(baseDir, config.storage.mediaDir);
}
