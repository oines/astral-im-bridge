import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

test("openai_speech TTS allows a local endpoint without an API key", () => {
  const config = loadTestConfig({
    enabled: true,
    protocol: "openai_speech",
    apiKey: null,
    baseUrl: "http://127.0.0.1:8765/v1",
    model: "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16",
    voice: null,
    format: "mp3",
    language: "Chinese",
    referenceAudioPath: "/Users/test/atri.wav",
    referenceText: "参考音频文字",
  });

  assert.equal(config.tts.protocol, "openai_speech");
  assert.equal(config.tts.apiKey, null);
  assert.equal(config.tts.referenceAudioPath, "/Users/test/atri.wav");
});

test("chat_completions TTS still requires an API key and configured voice", () => {
  assert.throws(
    () => loadTestConfig({
      enabled: true,
      protocol: "chat_completions",
      apiKey: null,
      voice: "mimo_default",
    }),
    /apiKey is required/,
  );
  assert.throws(
    () => loadTestConfig({
      enabled: true,
      protocol: "chat_completions",
      apiKey: "secret",
      voice: null,
    }),
    /voice is required/,
  );
});

test("voice clone reference audio and transcript must be configured together", () => {
  assert.throws(
    () => loadTestConfig({
      enabled: true,
      protocol: "openai_speech",
      apiKey: null,
      referenceAudioPath: "/Users/test/atri.wav",
      referenceText: null,
    }),
    /must be configured together/,
  );
});

function loadTestConfig(tts: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astral-bridge-tts-config-"));
  const configPath = path.join(dir, "bridge.json");
  fs.writeFileSync(configPath, JSON.stringify({ tts }));
  return loadConfig(["--config", configPath]);
}
