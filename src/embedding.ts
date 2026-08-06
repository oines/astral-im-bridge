import { createHash } from "node:crypto";
import { log, warn } from "./logger.js";
import type { EmbeddingConfig } from "./types.js";

const MAX_EMBEDDING_TEXT_CHARS = 16_000;

export interface EmbeddingJob {
  messageRowId: number;
  contentHash: string;
  text: string;
  platform: string;
  sourceType: string;
  targetId: string;
  userId: string;
  time: number;
}

export interface EmbeddingWrite extends EmbeddingJob {
  embedding: Uint8Array;
}

export interface EmbeddingBackfillResult {
  queued: number;
  scanned: number;
  complete: boolean;
}

export interface EmbeddingJobStore {
  enqueueEmbeddingBackfill(limit: number): EmbeddingBackfillResult;
  pendingEmbeddingJobs(limit: number): EmbeddingJob[];
  completeEmbeddingJobs(writes: EmbeddingWrite[]): number;
  failEmbeddingJobs(jobs: EmbeddingJob[], error: string): void;
}

export class EmbeddingClient {
  constructor(private readonly config: EmbeddingConfig) {}

  async embedDocuments(texts: string[]): Promise<Uint8Array[]> {
    return this.embed(texts);
  }

  async embedQuery(text: string): Promise<Uint8Array> {
    const query = text.trim();
    if (!query) {
      throw new Error("Embedding query must not be empty");
    }
    const [vector] = await this.embed([
      `Instruct: ${this.config.queryInstruction}\nQuery: ${query}`,
    ]);
    if (!vector) {
      throw new Error("Embedding service returned no query vector");
    }
    return vector;
  }

  private async embed(texts: string[]): Promise<Uint8Array[]> {
    if (texts.length === 0) {
      return [];
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.config.apiKey) {
        headers.authorization = `Bearer ${this.config.apiKey}`;
      }
      const response = await fetch(`${this.config.baseUrl}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.model,
          input: texts,
          encoding_format: "float",
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 1_000);
        throw new Error(
          `Embedding service returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        );
      }
      const payload = await response.json() as EmbeddingResponse;
      if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
        throw new Error(
          `Embedding service returned ${payload.data?.length ?? 0} vectors for ${texts.length} inputs`,
        );
      }
      const ordered = [...payload.data].sort((a, b) => a.index - b.index);
      return ordered.map((item, index) => {
        if (item.index !== index || !Array.isArray(item.embedding)) {
          throw new Error(`Embedding service returned an invalid vector at index ${index}`);
        }
        if (item.embedding.length !== this.config.dimensions) {
          throw new Error(
            `Embedding vector ${index} has ${item.embedding.length} dimensions; expected ${this.config.dimensions}`,
          );
        }
        if (!item.embedding.every(Number.isFinite)) {
          throw new Error(`Embedding vector ${index} contains non-finite values`);
        }
        return float32VectorBytes(item.embedding);
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`Embedding request timed out after ${this.config.timeoutMs}ms`, { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class EmbeddingIndexer {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private indexedSinceStart = 0;
  private backfillComplete = false;

  constructor(
    private readonly config: EmbeddingConfig,
    private readonly store: EmbeddingJobStore,
    private readonly client = new EmbeddingClient(config),
  ) {}

  start(): void {
    if (this.running || !this.config.enabled) {
      return;
    }
    this.running = true;
    log("embedding indexer started", {
      model: this.config.model,
      dimensions: this.config.dimensions,
      batchSize: this.config.batchSize,
    });
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let jobs: EmbeddingJob[] = [];
      try {
        jobs = this.store.pendingEmbeddingJobs(this.config.batchSize);
        if (jobs.length === 0 && !this.backfillComplete) {
          const backfill = this.store.enqueueEmbeddingBackfill(this.config.batchSize);
          this.backfillComplete = backfill.complete;
          jobs = this.store.pendingEmbeddingJobs(this.config.batchSize);
          if (jobs.length === 0 && !backfill.complete && backfill.scanned > 0) {
            await sleep(0);
            continue;
          }
        }
        if (jobs.length === 0) {
          await this.waitWhileRunning(1_000);
          continue;
        }
        const vectors = await this.client.embedDocuments(jobs.map((job) => job.text));
        const completed = this.store.completeEmbeddingJobs(
          jobs.map((job, index) => ({ ...job, embedding: vectors[index] })),
        );
        this.consecutiveFailures = 0;
        this.indexedSinceStart += completed;
        if (
          completed > 0
          && (this.indexedSinceStart === completed || this.indexedSinceStart % 1_000 < completed)
        ) {
          log("embedding indexer progress", { indexedSinceStart: this.indexedSinceStart });
        }
      } catch (err) {
        const message = errorMessage(err);
        if (jobs.length > 0) {
          this.store.failEmbeddingJobs(jobs, message);
        }
        this.consecutiveFailures += 1;
        const retryDelayMs = Math.min(
          300_000,
          5_000 * (2 ** Math.min(this.consecutiveFailures - 1, 6)),
        );
        warn("embedding indexer request failed", {
          error: message,
          retryDelayMs,
        });
        await this.waitWhileRunning(retryDelayMs);
      }
    }
  }

  private async waitWhileRunning(milliseconds: number): Promise<void> {
    const deadline = Date.now() + milliseconds;
    while (this.running && Date.now() < deadline) {
      await sleep(Math.min(1_000, deadline - Date.now()));
    }
  }
}

export function embeddingDocumentText(text: string, rawMessage: string): string {
  const primary = String(text ?? "").trim();
  const fallback = String(rawMessage ?? "").trim();
  return (primary || fallback).slice(0, MAX_EMBEDDING_TEXT_CHARS);
}

export function embeddingContentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function float32VectorBytes(values: number[]): Uint8Array {
  const vector = Float32Array.from(values);
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 2_000);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface EmbeddingResponse {
  data?: Array<{
    index: number;
    embedding: number[];
  }>;
}
