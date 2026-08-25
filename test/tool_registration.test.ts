import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { createBridgeMcpServer } from "../src/mcp.ts";
import { OneBotClient } from "../src/onebot.ts";
import { MessageStore } from "../src/store.ts";
import { TelegramClient } from "../src/telegram.ts";

test("MCP exposes only configured channels and capabilities", () => {
  const none = toolNames(configFor({}));
  assert.deepEqual(none, ["query_messages"]);

  const qq = toolNames(configFor({
    qq: { enabled: true, botUserId: "123456" },
  }));
  assert.equal(qq.includes("qq_send_group_message"), true);
  assert.equal(qq.includes("qq_get_forward_messages"), true);
  assert.equal(qq.includes("qq_send_group_voice"), false);
  assert.equal(qq.some((name) => name.startsWith("telegram_")), false);

  const telegram = toolNames(configFor({
    telegram: {
      enabled: true,
      botToken: "test-token",
      botUsername: "test_bot",
    },
  }));
  assert.equal(telegram.includes("telegram_send_message"), true);
  assert.equal(telegram.includes("telegram_send_voice"), false);
  assert.equal(telegram.some((name) => name.startsWith("qq_")), false);

  const allWithTts = toolNames(configFor({
    qq: { enabled: true, botUserId: "123456" },
    telegram: {
      enabled: true,
      botToken: "test-token",
      botUsername: "test_bot",
    },
    tts: {
      enabled: true,
      protocol: "openai_speech",
      baseUrl: "http://127.0.0.1:8765/v1",
      model: "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16",
      format: "mp3",
    },
  }));
  assert.equal(allWithTts.includes("qq_send_group_voice"), true);
  assert.equal(allWithTts.includes("qq_send_private_voice"), true);
  assert.equal(allWithTts.includes("telegram_send_voice"), true);
});

function configFor(patch: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astral-bridge-tools-"));
  const configPath = path.join(dir, "bridge.json");
  fs.writeFileSync(configPath, JSON.stringify({
    storage: {
      dbPath: path.join(dir, "bridge.db"),
      mediaDir: path.join(dir, "media"),
    },
    ...patch,
  }));
  return loadConfig(["--config", configPath]);
}

function toolNames(config: ReturnType<typeof loadConfig>): string[] {
  const onebot = new OneBotClient(config.onebot);
  const telegram = config.telegram.enabled ? new TelegramClient(config.telegram) : null;
  const store = new MessageStore(config.storage);
  const server = createBridgeMcpServer(config, onebot, telegram, store);
  const registered = Reflect.get(server, "_registeredTools") as Record<string, unknown>;
  return Object.keys(registered).sort();
}
