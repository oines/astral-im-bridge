import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

test("message embeddings are disabled by default", () => {
  const config = loadTestConfig({});
  assert.equal(config.embedding.enabled, false);
  assert.equal(config.embedding.dimensions, 1024);
  assert.equal(config.embedding.model, "qwen3-embedding-0.6b");
});

test("embedding configuration accepts a local OpenAI-compatible endpoint", () => {
  const config = loadTestConfig({
    enabled: true,
    baseUrl: "http://host.docker.internal:8766/v1/",
    apiKey: null,
    model: "qwen3-embedding-0.6b",
    dimensions: 1024,
    batchSize: 32,
    timeoutMs: 60_000,
    queryInstruction: "Retrieve relevant messages.",
  });
  assert.equal(config.embedding.enabled, true);
  assert.equal(config.embedding.baseUrl, "http://host.docker.internal:8766/v1");
  assert.equal(config.embedding.apiKey, null);
});

test("embedding configuration rejects invalid dimensions and blank instructions", () => {
  assert.throws(
    () => loadTestConfig({ dimensions: 0 }),
    /dimensions must be a positive integer/,
  );
  assert.throws(
    () => loadTestConfig({ queryInstruction: "" }),
    /queryInstruction must not be empty/,
  );
});

function loadTestConfig(embedding: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astral-bridge-embedding-config-"));
  const configPath = path.join(dir, "bridge.json");
  fs.writeFileSync(configPath, JSON.stringify({ embedding }));
  return loadConfig(["--config", configPath]);
}
