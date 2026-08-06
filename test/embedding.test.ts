import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EmbeddingClient,
  EmbeddingIndexer,
  float32VectorBytes,
} from "../src/embedding.ts";
import { MESSAGE_QUERY_TIMEOUT_MS, runMessageQuery } from "../src/message_query.ts";
import { MessageStore } from "../src/store.ts";
import type { EmbeddingConfig, StoredMessage } from "../src/types.ts";

test("EmbeddingClient preserves batch order and validates dimensions", async (t) => {
  const endpoint = await startEmbeddingServer((inputs) => [...inputs].reverse().map((text, reverseIndex) => ({
    index: inputs.length - reverseIndex - 1,
    embedding: vectorFor(text),
  })));
  t.after(() => endpoint.server.close());
  const client = new EmbeddingClient(embeddingConfig(endpoint.baseUrl));

  const vectors = await client.embedDocuments(["显卡坏了", "串流画面"]);
  assert.deepEqual(Array.from(new Float32Array(vectors[0].buffer)), [1, 0, 0]);
  assert.deepEqual(Array.from(new Float32Array(vectors[1].buffer)), [0, 1, 0]);
});

test("async indexing supports semantic, hybrid, metadata filters, and embed plus SQL", async (t) => {
  const endpoint = await startEmbeddingServer((inputs) => inputs.map((text, index) => ({
    index,
    embedding: vectorFor(text),
  })));
  t.after(() => endpoint.server.close());
  const config = embeddingConfig(endpoint.baseUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astral-bridge-embedding-"));
  const dbPath = path.join(dir, "messages.sqlite");
  const store = new MessageStore({
    dbPath,
    mediaDir: path.join(dir, "media"),
    downloadMedia: false,
  }, config);
  store.saveMessage(makeMessage(1, "显卡突然坏了", "group-a"));
  store.saveMessage(makeMessage(2, "串流画面有问题", "group-a"));
  store.saveMessage(makeMessage(3, "今天天气不错", "group-b"));

  const indexer = new EmbeddingIndexer(config, store);
  indexer.start();
  t.after(async () => indexer.stop());
  await waitFor(() => store.embeddingIndexStats().indexed === 3);
  assert.deepEqual(store.embeddingIndexStats(), { indexed: 3, pending: 0, failed: 0 });

  const semantic = await runMessageQuery(dbPath, `
    return await search("上次谁说显卡坏了", {
      mode: "semantic", platform: "qq", target_id: "group-a", context_limit: 0
    });
  `, MESSAGE_QUERY_TIMEOUT_MS, config) as {
    mode: string;
    hits: Array<Record<string, unknown>>;
  };
  assert.equal(semantic.mode, "semantic");
  assert.equal(semantic.hits[0]?.message_id, "1");
  assert.equal(typeof semantic.hits[0]?.semantic_distance, "number");

  const hybrid = await runMessageQuery(dbPath, `
    return await search("串流画面", { target_id: "group-a", context_limit: 0 });
  `, MESSAGE_QUERY_TIMEOUT_MS, config) as {
    mode: string;
    hits: Array<Record<string, unknown>>;
  };
  assert.equal(hybrid.mode, "hybrid");
  assert.equal(hybrid.hits[0]?.message_id, "2");
  assert.equal(typeof hybrid.hits[0]?.rrf_score, "number");

  const custom = await runMessageQuery(dbPath, `
    const vector = await embed("显卡问题");
    return sql(
      "SELECT m.platform_message_id AS message_id, e.distance FROM message_embeddings AS e JOIN messages AS m ON m.id = e.message_row_id WHERE e.embedding MATCH ? AND e.k = ? AND e.target_id = ? ORDER BY e.distance",
      vector, 2, "group-a"
    );
  `, MESSAGE_QUERY_TIMEOUT_MS, config) as Array<Record<string, unknown>>;
  assert.equal(custom[0]?.message_id, "1");
});

test("stale embedding writes cannot overwrite an updated message", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astral-bridge-embedding-race-"));
  const config = embeddingConfig("http://127.0.0.1:1/v1");
  const store = new MessageStore({
    dbPath: path.join(dir, "messages.sqlite"),
    mediaDir: path.join(dir, "media"),
    downloadMedia: false,
  }, config);
  store.saveMessage(makeMessage(1, "旧内容", "group-a"));
  const [stale] = store.pendingEmbeddingJobs(1);
  assert.ok(stale);

  store.saveMessage(makeMessage(1, "新内容", "group-a"));
  const completed = store.completeEmbeddingJobs([{
    ...stale,
    embedding: float32VectorBytes([1, 0, 0]),
  }]);
  assert.equal(completed, 0);
  assert.equal(store.embeddingIndexStats().pending, 1);
  assert.equal(store.pendingEmbeddingJobs(1)[0]?.text, "新内容");
});

test("semantic search fails clearly when the service is unavailable while lexical still works", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astral-bridge-embedding-down-"));
  const dbPath = path.join(dir, "messages.sqlite");
  const config = embeddingConfig("http://127.0.0.1:1/v1");
  const store = new MessageStore({
    dbPath,
    mediaDir: path.join(dir, "media"),
    downloadMedia: false,
  }, config);
  store.saveMessage(makeMessage(1, "显卡坏了", "group-a"));

  await assert.rejects(
    runMessageQuery(
      dbPath,
      `return await search("显卡", { mode: "semantic", context_limit: 0 });`,
      MESSAGE_QUERY_TIMEOUT_MS,
      config,
    ),
    /fetch failed|embedding/i,
  );
  const lexical = await runMessageQuery(
    dbPath,
    `return search("显卡", { mode: "lexical", context_limit: 0 });`,
    MESSAGE_QUERY_TIMEOUT_MS,
    config,
  ) as { hits: Array<Record<string, unknown>> };
  assert.equal(lexical.hits[0]?.message_id, "1");
});

test("changing embedding model invalidates vectors and queues a fresh backfill", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astral-bridge-embedding-version-"));
  const storage = {
    dbPath: path.join(dir, "messages.sqlite"),
    mediaDir: path.join(dir, "media"),
    downloadMedia: false,
  };
  const initialConfig = embeddingConfig("http://127.0.0.1:1/v1");
  const initial = new MessageStore(storage, initialConfig);
  initial.saveMessage(makeMessage(1, "需要重建", "group-a"));
  const job = initial.pendingEmbeddingJobs(1)[0];
  assert.ok(job);
  assert.equal(initial.completeEmbeddingJobs([{
    ...job,
    embedding: float32VectorBytes([1, 0, 0]),
  }]), 1);
  assert.equal(initial.embeddingIndexStats().indexed, 1);

  const changed = new MessageStore(storage, { ...initialConfig, model: "replacement-model" });
  assert.deepEqual(changed.embeddingIndexStats(), { indexed: 0, pending: 0, failed: 0 });
  assert.equal(changed.enqueueEmbeddingBackfill(10), 1);
  assert.equal(changed.pendingEmbeddingJobs(1)[0]?.text, "需要重建");
});

function embeddingConfig(baseUrl: string): EmbeddingConfig {
  return {
    enabled: true,
    baseUrl,
    apiKey: null,
    model: "qwen3-embedding-0.6b",
    dimensions: 3,
    batchSize: 2,
    timeoutMs: 2_000,
    queryInstruction: "Retrieve relevant instant messages.",
  };
}

function makeMessage(index: number, text: string, targetId: string): StoredMessage {
  return {
    platform: "qq",
    platformMessageId: String(index),
    sourceType: "group",
    targetId,
    groupId: targetId,
    groupName: "Test Group",
    userId: `user-${index}`,
    nickname: `User ${index}`,
    groupCard: null,
    role: null,
    time: 1_700_000_000 + index,
    text,
    rawMessage: text,
    trigger: "none",
    replyToMessageId: null,
    rawEvent: { index },
    attachments: [],
  };
}

async function startEmbeddingServer(
  respond: (inputs: string[]) => Array<{ index: number; embedding: number[] }>,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: string[] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: respond(body.input) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock embedding server did not bind a TCP port");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

function vectorFor(text: string): number[] {
  if (text.includes("显卡")) {
    return [1, 0, 0];
  }
  if (text.includes("串流")) {
    return [0, 1, 0];
  }
  return [0, 0, 1];
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for embedding indexer");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
