import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

const ENV_KEYS = [
  "ASTRAL_BRIDGE_CONFIG",
  "ASTRAL_BRIDGE_THREAD_ID",
  "ASTRAL_BRIDGE_ROTATE_THREAD_ON_START",
];

function withCleanEnv(fn: () => void): void {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  try {
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function writeConfig(astral: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astral-bridge-config-"));
  const configPath = path.join(dir, "bridge.config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    qq: { botUserId: "123456" },
    astral,
  }));
  return configPath;
}

test("loadConfig allows auto-managed Astral thread", () => {
  withCleanEnv(() => {
    const configPath = writeConfig({});
    const config = loadConfig(["--config", configPath]);

    assert.equal(config.astral.threadId, "");
    assert.equal(config.astral.rotateThreadOnStart, false);
  });
});

test("loadConfig treats thread placeholders as auto-managed", () => {
  withCleanEnv(() => {
    for (const threadId of ["auto", "REPLACE_WITH_FIXED_THREAD_ID", "SET_BY_ASTRAL_BRIDGE_THREAD_ID_ENV"]) {
      const configPath = writeConfig({ threadId });
      const config = loadConfig(["--config", configPath]);
      assert.equal(config.astral.threadId, "");
    }
  });
});

test("loadConfig preserves explicit thread id and rotate-on-start env", () => {
  withCleanEnv(() => {
    process.env.ASTRAL_BRIDGE_ROTATE_THREAD_ON_START = "true";
    const configPath = writeConfig({ threadId: "thread-123" });
    const config = loadConfig(["--config", configPath]);

    assert.equal(config.astral.threadId, "thread-123");
    assert.equal(config.astral.rotateThreadOnStart, true);
  });
});
