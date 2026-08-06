import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { EmbeddingClient } from "./embedding.js";
import { buildFtsMatchQuery } from "./message_fts.js";
import type { EmbeddingConfig } from "./types.js";

export const MESSAGE_QUERY_TIMEOUT_MS = 30_000;

interface QueryRequest {
  dbPath: string;
  code: string;
  timeoutMs: number;
  embedding: EmbeddingConfig | null;
}

interface QuerySuccess {
  ok: true;
  result: unknown;
}

interface QueryFailure {
  ok: false;
  error: string;
}

type QueryResponse = QuerySuccess | QueryFailure;

interface QueryFilters {
  platform?: unknown;
  source_type?: unknown;
  target_id?: unknown;
  user_id?: unknown;
  message_id?: unknown;
  reply_to_message_id?: unknown;
  trigger?: unknown;
  after?: unknown;
  before?: unknown;
  has_attachments?: unknown;
  order?: unknown;
  limit?: unknown;
}

interface SearchOptions extends QueryFilters {
  mode?: unknown;
  context_limit?: unknown;
}

interface ContextOptions {
  before?: unknown;
  after?: unknown;
  reply_depth?: unknown;
}

interface ConversationOptions {
  platform?: unknown;
  source_type?: unknown;
  target_id?: unknown;
  user_id?: unknown;
  after?: unknown;
  before?: unknown;
  min_messages?: unknown;
  limit?: unknown;
}

interface MessageRow extends Record<string, unknown> {
  row_id: number;
  platform: string;
  message_id: string;
  source_type: string;
  target_id: string;
  time_unix: number;
  reply_to_message_id: string | null;
}

interface RankedMessageRow extends MessageRow {
  rank?: number;
  bm25_rank?: number;
  semantic_distance?: number;
  rrf_score?: number;
}

type SearchMode = "lexical" | "semantic" | "hybrid";

const MESSAGE_SELECT = `
  m.id AS row_id,
  m.platform,
  m.platform_message_id AS message_id,
  m.source_type,
  m.target_id,
  m.group_id,
  m.group_name,
  m.user_id AS sender_user_id,
  m.nickname AS sender_nickname,
  m.group_card AS sender_group_card,
  m.role AS sender_role,
  COALESCE(NULLIF(m.group_card, ''), NULLIF(m.nickname, ''), m.user_id) AS sender_display_name,
  m.time AS time_unix,
  m.text,
  m.raw_message,
  m.trigger,
  m.reply_to_message_id
`;

const BASE_QUERY_TABLES = ["messages", "attachments", "messages_fts"] as const;

export function runMessageQuery(
  dbPath: string,
  code: string,
  timeoutMs = MESSAGE_QUERY_TIMEOUT_MS,
  embeddingConfig?: EmbeddingConfig,
): Promise<unknown> {
  if (!code.trim()) {
    return Promise.reject(new Error("Query code must not be empty"));
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("Query timeout must be a positive number"));
  }

  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), [], {
      env: {
        ...process.env,
        ASTRAL_BRIDGE_MESSAGE_QUERY_CHILD: "1",
      },
      execArgv: childExecArgv(),
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let settled = false;
    let stderr = "";

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error(`Message query timed out after ${Math.trunc(timeoutMs)}ms`));
      });
    }, timeoutMs);

    child.once("message", (message: QueryResponse) => {
      finish(() => {
        if (message.ok) {
          resolve(message.result);
        } else {
          reject(new Error(message.error));
        }
      });
    });

    child.once("error", (err) => {
      finish(() => reject(err));
    });

    child.once("exit", (codeValue, signal) => {
      finish(() => {
        const detail = stderr.trim();
        const suffix = detail ? `: ${detail}` : "";
        reject(new Error(`Message query process exited before returning a result (${signal ?? codeValue})${suffix}`));
      });
    });

    child.send({
      dbPath,
      code,
      timeoutMs,
      embedding: embeddingConfig?.enabled ? embeddingConfig : null,
    } satisfies QueryRequest, (err) => {
      if (err) {
        finish(() => reject(err));
      }
    });
  });
}

function childExecArgv(): string[] {
  if (!import.meta.url.endsWith(".ts")) {
    return [];
  }
  const args: string[] = [];
  for (let i = 0; i < process.execArgv.length; i += 1) {
    const arg = process.execArgv[i];
    if (arg === "--input-type") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--input-type=")) {
      continue;
    }
    if (arg === "--eval" || arg === "-e" || arg === "--print" || arg === "-p") {
      i += 1;
      continue;
    }
    if (arg === "--test") {
      continue;
    }
    args.push(arg);
  }
  return args;
}

async function executeQuery(request: QueryRequest): Promise<unknown> {
  const db = new DatabaseSync(request.dbPath, {
    readOnly: true,
    allowExtension: request.embedding !== null,
  });
  try {
    if (request.embedding) {
      sqliteVec.load(db);
      db.enableLoadExtension(false);
    }
    db.exec("PRAGMA query_only = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    const helpers = createQueryHelpers(db, request.embedding);
    const sandbox = Object.create(null) as Record<string, unknown>;
    for (const [name, helper] of Object.entries(helpers)) {
      Object.defineProperty(sandbox, name, {
        value: helper,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    const context = createContext(sandbox, {
      name: "astral-bridge-message-query",
      codeGeneration: { strings: false, wasm: false },
    });
    const script = new Script(`"use strict";\n(async () => {\n${request.code}\n})()`, {
      filename: "query_messages.js",
    });
    const result = await script.runInContext(context, { timeout: request.timeoutMs });
    if (result === undefined) {
      throw new Error("Query code returned undefined; finish the code with return <json_value>");
    }
    return normalizeJsonValue(result);
  } finally {
    db.close();
  }
}

function createQueryHelpers(
  db: DatabaseSync,
  embeddingConfig: EmbeddingConfig | null,
): Record<string, (...args: never[]) => unknown> {
  const helpers: Record<string, (...args: never[]) => unknown> = {
    search: ((text: string, options: SearchOptions = {}) => searchMessages(
      db,
      text,
      options,
      embeddingConfig,
    )) as (...args: never[]) => unknown,
    messages: ((options: QueryFilters = {}) => queryMessages(db, options)) as (...args: never[]) => unknown,
    context: ((rowId: number, options: ContextOptions = {}) => messageContext(db, rowId, options)) as (...args: never[]) => unknown,
    conversations: ((options: ConversationOptions = {}) => queryConversations(db, options)) as (...args: never[]) => unknown,
    sql: ((query: string, ...params: unknown[]) => querySql(db, query, params)) as (...args: never[]) => unknown,
    schema: ((table?: string) => querySchema(db, table, embeddingConfig !== null)) as (...args: never[]) => unknown,
  };
  if (embeddingConfig) {
    const client = new EmbeddingClient(embeddingConfig);
    helpers.embed = (async (text: string) => client.embedQuery(text)) as (...args: never[]) => unknown;
  }
  return Object.freeze(helpers);
}

function searchMessages(
  db: DatabaseSync,
  text: string,
  rawOptions: SearchOptions,
  embeddingConfig: EmbeddingConfig | null,
): Record<string, unknown> | Promise<Record<string, unknown>> {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("search(text, opts) requires non-empty text");
  }
  const options = requireOptions(rawOptions, "search options") as SearchOptions;
  const limit = positiveInteger(options.limit, 20, "search limit");
  const contextLimit = nonNegativeInteger(options.context_limit, 1, "context_limit");
  const mode = searchMode(options.mode, embeddingConfig !== null);
  if (mode === "lexical") {
    const rows = lexicalSearchRows(db, text, options, limit);
    return searchResult(db, text, mode, rows, contextLimit);
  }
  if (!embeddingConfig) {
    throw new Error(
      `search mode ${mode} requires embedding.enabled=true and a working embedding service`,
    );
  }
  return semanticSearchResult(db, text, options, limit, contextLimit, mode, embeddingConfig);
}

function lexicalSearchRows(
  db: DatabaseSync,
  text: string,
  options: SearchOptions,
  limit: number,
): RankedMessageRow[] {
  const matchQuery = buildFtsMatchQuery(text);
  if (!matchQuery) {
    return [];
  }
  const clauses = ["messages_fts MATCH ?"];
  const params: SqlValue[] = [matchQuery];
  appendMessageFilters(clauses, params, options, "m");

  return db.prepare(
    `SELECT ${MESSAGE_SELECT}, bm25(messages_fts) AS rank, bm25(messages_fts) AS bm25_rank
     FROM messages_fts
     JOIN messages AS m ON m.id = messages_fts.rowid
     WHERE ${clauses.join(" AND ")}
     ORDER BY bm25_rank ASC, m.time DESC, m.id DESC
     LIMIT ?`,
  ).all(...params, limit) as unknown as RankedMessageRow[];
}

async function semanticSearchResult(
  db: DatabaseSync,
  text: string,
  options: SearchOptions,
  limit: number,
  contextLimit: number,
  mode: "semantic" | "hybrid",
  embeddingConfig: EmbeddingConfig,
): Promise<Record<string, unknown>> {
  const vector = await new EmbeddingClient(embeddingConfig).embedQuery(text);
  if (mode === "semantic") {
    const rows = semanticSearchRows(db, vector, options, limit);
    return searchResult(db, text, mode, rows, contextLimit);
  }
  const candidateLimit = limit > Math.floor(Number.MAX_SAFE_INTEGER / 4)
    ? Number.MAX_SAFE_INTEGER
    : Math.max(50, limit * 4);
  const lexical = lexicalSearchRows(db, text, options, candidateLimit);
  const semantic = semanticSearchRows(db, vector, options, candidateLimit);
  const combined = new Map<number, RankedMessageRow & { lexical_order?: number; semantic_order?: number }>();
  lexical.forEach((row, index) => {
    combined.set(row.row_id, { ...row, lexical_order: index + 1 });
  });
  semantic.forEach((row, index) => {
    const existing = combined.get(row.row_id);
    combined.set(row.row_id, {
      ...(existing ?? row),
      semantic_distance: row.semantic_distance,
      semantic_order: index + 1,
    });
  });
  const rows = [...combined.values()]
    .map((row) => {
      const rrfScore = (row.lexical_order ? 1.2 / (60 + row.lexical_order) : 0)
        + (row.semantic_order ? 1 / (60 + row.semantic_order) : 0);
      const { lexical_order: _lexicalOrder, semantic_order: _semanticOrder, ...fields } = row;
      return { ...fields, rrf_score: rrfScore };
    })
    .sort((a, b) => (
      (b.rrf_score ?? 0) - (a.rrf_score ?? 0)
      || b.time_unix - a.time_unix
      || b.row_id - a.row_id
    ))
    .slice(0, limit);
  return searchResult(db, text, mode, rows, contextLimit);
}

function semanticSearchRows(
  db: DatabaseSync,
  vector: Uint8Array,
  options: SearchOptions,
  limit: number,
): RankedMessageRow[] {
  const clauses = ["e.embedding MATCH ?", "e.k = ?"];
  const params: SqlValue[] = [vector, limit];
  appendStringFilter(clauses, params, "e.platform", options.platform, "platform", ["qq", "telegram"]);
  appendStringFilter(
    clauses,
    params,
    "e.source_type",
    options.source_type,
    "source_type",
    ["group", "private"],
  );
  appendStringFilter(clauses, params, "e.target_id", options.target_id, "target_id");
  appendStringFilter(clauses, params, "e.user_id", options.user_id, "user_id");
  appendTimeFilter(clauses, params, "e.time", ">=", options.after, "after");
  appendTimeFilter(clauses, params, "e.time", "<=", options.before, "before");
  return db.prepare(
    `SELECT ${MESSAGE_SELECT}, e.distance AS semantic_distance
     FROM message_embeddings AS e
     JOIN messages AS m ON m.id = e.message_row_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY e.distance ASC, m.time DESC, m.id DESC`,
  ).all(...params) as unknown as RankedMessageRow[];
}

function searchResult(
  db: DatabaseSync,
  text: string,
  mode: SearchMode,
  rows: RankedMessageRow[],
  contextLimit: number,
): Record<string, unknown> {
  return {
    query: text,
    mode,
    returned_count: rows.length,
    hits: rows.map((row) => {
      if (contextLimit === 0) {
        return row;
      }
      const nearby = neighboringMessages(db, row, contextLimit, contextLimit);
      return {
        ...row,
        context_before: nearby.before,
        context_after: nearby.after,
      };
    }),
  };
}

function searchMode(value: unknown, embeddingEnabled: boolean): SearchMode {
  if (value === undefined) {
    return embeddingEnabled ? "hybrid" : "lexical";
  }
  if (value === "lexical" || value === "semantic" || value === "hybrid") {
    return value;
  }
  throw new Error("search mode must be lexical, semantic, or hybrid");
}

function queryMessages(db: DatabaseSync, rawOptions: QueryFilters): MessageRow[] {
  const options = requireOptions(rawOptions, "messages options") as QueryFilters;
  const limit = positiveInteger(options.limit, 50, "messages limit");
  const order = queryOrder(options.order);
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  appendMessageFilters(clauses, params, options, "m");
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(
    `SELECT ${MESSAGE_SELECT}
     FROM messages AS m
     ${where}
     ORDER BY m.time ${order}, m.id ${order}
     LIMIT ?`,
  ).all(...params, limit) as unknown as MessageRow[];
}

function messageContext(db: DatabaseSync, rawRowId: number, rawOptions: ContextOptions): Record<string, unknown> {
  const rowId = positiveInteger(rawRowId, undefined, "row_id");
  const options = requireOptions(rawOptions, "context options") as ContextOptions;
  const beforeCount = nonNegativeInteger(options.before, 10, "context before");
  const afterCount = nonNegativeInteger(options.after, 10, "context after");
  const replyDepth = nonNegativeInteger(options.reply_depth, 5, "reply_depth");
  const target = messageByRowId(db, rowId);
  if (!target) {
    throw new Error(`Message row_id ${rowId} was not found`);
  }
  const nearby = neighboringMessages(db, target, beforeCount, afterCount);
  const replyChain: Record<string, unknown>[] = [];
  const seen = new Set<number>([target.row_id]);
  let current: MessageRow | null = target;
  while (current?.reply_to_message_id && replyChain.length < replyDepth) {
    current = messageByPlatformId(db, current, current.reply_to_message_id);
    if (!current || seen.has(current.row_id)) {
      break;
    }
    seen.add(current.row_id);
    replyChain.push(messageWithAttachments(db, current));
  }

  return {
    target: messageWithAttachments(db, target),
    reply_chain: replyChain,
    before: nearby.before,
    after: nearby.after,
  };
}

function queryConversations(db: DatabaseSync, rawOptions: ConversationOptions): Record<string, unknown>[] {
  const options = requireOptions(rawOptions, "conversations options") as ConversationOptions;
  const limit = positiveInteger(options.limit, 50, "conversations limit");
  const minMessages = positiveInteger(options.min_messages, 1, "min_messages");
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  appendStringFilter(clauses, params, "m.platform", options.platform, "platform", ["qq", "telegram"]);
  appendStringFilter(clauses, params, "m.source_type", options.source_type, "source_type", ["group", "private"]);
  appendStringFilter(clauses, params, "m.target_id", options.target_id, "target_id");
  appendTimeFilter(clauses, params, "m.time", ">=", options.after, "after");
  appendTimeFilter(clauses, params, "m.time", "<=", options.before, "before");
  if (options.user_id !== undefined) {
    if (typeof options.user_id !== "string" || !options.user_id) {
      throw new Error("user_id must be a non-empty string");
    }
    const participantClauses = [
      "participant.platform = m.platform",
      "participant.source_type = m.source_type",
      "participant.target_id = m.target_id",
      "participant.user_id = ?",
    ];
    const participantParams: SqlValue[] = [options.user_id];
    appendTimeFilter(participantClauses, participantParams, "participant.time", ">=", options.after, "after");
    appendTimeFilter(participantClauses, participantParams, "participant.time", "<=", options.before, "before");
    clauses.push(`EXISTS (SELECT 1 FROM messages AS participant WHERE ${participantClauses.join(" AND ")})`);
    params.push(...participantParams);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const summaries = db.prepare(
    `WITH filtered AS (
       SELECT m.*
       FROM messages AS m
       ${where}
     ), ranked AS (
       SELECT
         filtered.*,
         ROW_NUMBER() OVER (
           PARTITION BY platform, source_type, target_id
           ORDER BY time DESC, id DESC
         ) AS recency_rank
       FROM filtered
     ), summaries AS (
       SELECT
         platform,
         source_type,
         target_id,
         COUNT(*) AS message_count,
         COUNT(DISTINCT user_id) AS participant_count,
         MIN(time) AS first_time_unix,
         MAX(time) AS last_time_unix
       FROM filtered
       GROUP BY platform, source_type, target_id
       HAVING COUNT(*) >= ?
     )
     SELECT summaries.*, ranked.id AS latest_row_id
     FROM summaries
     JOIN ranked
       ON ranked.platform = summaries.platform
      AND ranked.source_type = summaries.source_type
      AND ranked.target_id = summaries.target_id
      AND ranked.recency_rank = 1
     ORDER BY summaries.last_time_unix DESC, ranked.id DESC
     LIMIT ?`,
  ).all(...params, minMessages, limit) as unknown as Array<Record<string, unknown> & { latest_row_id: number }>;

  return summaries.map((summary) => {
    const latest = messageByRowId(db, summary.latest_row_id);
    const { latest_row_id: _latestRowId, ...fields } = summary;
    return {
      ...fields,
      group_name: latest?.group_name ?? null,
      latest_message: latest,
    };
  });
}

function querySql(db: DatabaseSync, query: string, rawParams: unknown[]): Record<string, unknown>[] {
  const normalized = normalizeReadOnlySql(query);
  const sourceParams = rawParams.length === 1 && Array.isArray(rawParams[0]) ? rawParams[0] : rawParams;
  const params = sourceParams.map(normalizeSqlValue);
  return db.prepare(normalized).all(...params) as Record<string, unknown>[];
}

function querySchema(
  db: DatabaseSync,
  requestedTable: string | undefined,
  embeddingEnabled: boolean,
): Record<string, unknown> {
  if (requestedTable !== undefined && typeof requestedTable !== "string") {
    throw new Error("schema(table) expects a table name string");
  }
  const queryTables = embeddingEnabled
    ? [...BASE_QUERY_TABLES, "message_embeddings"]
    : [...BASE_QUERY_TABLES];
  const names = requestedTable ? [requestedTable] : queryTables;
  for (const name of names) {
    if (!queryTables.includes(name)) {
      throw new Error(`Unknown query table ${name}; available tables: ${queryTables.join(", ")}`);
    }
  }
  const tables = names.map((name) => {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all() as Array<Record<string, unknown>>;
    if (name === "messages_fts") {
      columns.unshift({ cid: -1, name: "rowid", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 });
    }
    if (name === "message_embeddings") {
      columns.push(
        { cid: -1, name: "distance", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
        { cid: -2, name: "k", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      );
    }
    return {
      name,
      columns: columns.map((column) => ({
        name: column.name,
        type: column.type || null,
        not_null: Boolean(column.notnull),
        primary_key: Boolean(column.pk),
      })),
    };
  });
  return {
    tables,
    helpers: {
      search: embeddingEnabled
        ? "await search(text, {mode='hybrid'|'lexical'|'semantic', platform?, source_type?, target_id?, user_id?, after?, before?, limit=20, context_limit=1})"
        : "search(text, {platform?, source_type?, target_id?, user_id?, after?, before?, limit=20, context_limit=1})",
      messages: "messages({platform?, source_type?, target_id?, user_id?, message_id?, reply_to_message_id?, trigger?, after?, before?, has_attachments?, order='desc', limit=50})",
      context: "context(row_id, {before=10, after=10, reply_depth=5})",
      conversations: "conversations({platform?, source_type?, target_id?, user_id?, after?, before?, min_messages=1, limit=50})",
      sql: "sql(query, ...params) for one read-only SELECT or WITH query",
      ...(embeddingEnabled
        ? { embed: "await embed(text) returns a binary float32 query vector accepted by sql()" }
        : {}),
      schema: "schema(table?)",
    },
    ...(embeddingEnabled
      ? {
          vector_query:
            "const v = await embed(text); sql('SELECT message_row_id, distance FROM message_embeddings WHERE embedding MATCH ? AND k = ?', v, limit)",
        }
      : {}),
    time_format: "messages.time and helper time fields are Unix seconds; after/before also accept ISO-8601 strings",
  };
}

function appendMessageFilters(
  clauses: string[],
  params: SqlValue[],
  options: QueryFilters,
  alias: string,
): void {
  appendStringFilter(clauses, params, `${alias}.platform`, options.platform, "platform", ["qq", "telegram"]);
  appendStringFilter(clauses, params, `${alias}.source_type`, options.source_type, "source_type", ["group", "private"]);
  appendStringFilter(clauses, params, `${alias}.target_id`, options.target_id, "target_id");
  appendStringFilter(clauses, params, `${alias}.user_id`, options.user_id, "user_id");
  appendStringFilter(clauses, params, `${alias}.platform_message_id`, options.message_id, "message_id");
  appendStringFilter(
    clauses,
    params,
    `${alias}.reply_to_message_id`,
    options.reply_to_message_id,
    "reply_to_message_id",
  );
  appendStringFilter(clauses, params, `${alias}.trigger`, options.trigger, "trigger");
  appendTimeFilter(clauses, params, `${alias}.time`, ">=", options.after, "after");
  appendTimeFilter(clauses, params, `${alias}.time`, "<=", options.before, "before");
  if (options.has_attachments !== undefined) {
    if (typeof options.has_attachments !== "boolean") {
      throw new Error("has_attachments must be a boolean");
    }
    clauses.push(
      `${options.has_attachments ? "" : "NOT "}EXISTS (SELECT 1 FROM attachments AS a WHERE a.message_row_id = ${alias}.id)`,
    );
  }
}

function appendStringFilter(
  clauses: string[],
  params: SqlValue[],
  column: string,
  value: unknown,
  name: string,
  allowed?: string[],
): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || !value) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (allowed && !allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  clauses.push(`${column} = ?`);
  params.push(value);
}

function appendTimeFilter(
  clauses: string[],
  params: SqlValue[],
  column: string,
  operator: ">=" | "<=",
  value: unknown,
  name: string,
): void {
  if (value === undefined) {
    return;
  }
  clauses.push(`${column} ${operator} ?`);
  params.push(parseUnixTime(value, name));
}

function neighboringMessages(
  db: DatabaseSync,
  target: MessageRow,
  beforeCount: number,
  afterCount: number,
): { before: MessageRow[]; after: MessageRow[] } {
  const conversation = [target.platform, target.source_type, target.target_id] as const;
  const before = beforeCount === 0
    ? []
    : (db.prepare(
        `SELECT ${MESSAGE_SELECT}
         FROM messages AS m
         WHERE m.platform = ? AND m.source_type = ? AND m.target_id = ?
           AND (m.time < ? OR (m.time = ? AND m.id < ?))
         ORDER BY m.time DESC, m.id DESC
         LIMIT ?`,
      ).all(...conversation, target.time_unix, target.time_unix, target.row_id, beforeCount) as unknown as MessageRow[]).reverse();
  const after = afterCount === 0
    ? []
    : db.prepare(
        `SELECT ${MESSAGE_SELECT}
         FROM messages AS m
         WHERE m.platform = ? AND m.source_type = ? AND m.target_id = ?
           AND (m.time > ? OR (m.time = ? AND m.id > ?))
         ORDER BY m.time ASC, m.id ASC
         LIMIT ?`,
      ).all(...conversation, target.time_unix, target.time_unix, target.row_id, afterCount) as unknown as MessageRow[];
  return { before, after };
}

function messageByRowId(db: DatabaseSync, rowId: number): MessageRow | null {
  const row = db.prepare(
    `SELECT ${MESSAGE_SELECT}
     FROM messages AS m
     WHERE m.id = ?`,
  ).get(rowId) as MessageRow | undefined;
  return row ?? null;
}

function messageByPlatformId(db: DatabaseSync, source: MessageRow, messageId: string): MessageRow | null {
  const row = db.prepare(
    `SELECT ${MESSAGE_SELECT}
     FROM messages AS m
     WHERE m.platform = ? AND m.source_type = ? AND m.target_id = ? AND m.platform_message_id = ?
     ORDER BY m.time DESC, m.id DESC
     LIMIT 1`,
  ).get(source.platform, source.source_type, source.target_id, messageId) as MessageRow | undefined;
  return row ?? null;
}

function messageWithAttachments(db: DatabaseSync, message: MessageRow): Record<string, unknown> {
  const attachments = db.prepare(
    `SELECT
       id AS attachment_id,
       message_row_id,
       kind,
       file_id,
       name,
       url,
       path,
       mime_type,
       size,
       raw_json
     FROM attachments
     WHERE message_row_id = ?
     ORDER BY id ASC`,
  ).all(message.row_id) as Record<string, unknown>[];
  return { ...message, attachments };
}

function normalizeReadOnlySql(query: string): string {
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("sql(query, ...params) requires a non-empty query string");
  }
  let normalized = query.trim();
  const separator = findSqlStatementSeparator(normalized);
  if (separator !== -1) {
    if (normalized.slice(separator + 1).trim()) {
      throw new Error("sql() accepts one statement only");
    }
    normalized = normalized.slice(0, separator).trimEnd();
  }
  if (!/^(select|with)\b/i.test(normalized)) {
    throw new Error("sql() accepts read-only SELECT or WITH queries only");
  }
  return normalized;
}

function findSqlStatementSeparator(sql: string): number {
  let quote: "'" | "\"" | "`" | "]" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (quote === "]") {
        if (char === "]") {
          quote = null;
        }
        continue;
      }
      if (char === quote) {
        if ((quote === "'" || quote === "\"") && next === quote) {
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "[") {
      quote = "]";
      continue;
    }
    if (char === ";") {
      return i;
    }
  }
  return -1;
}

type SqlValue = string | number | bigint | Uint8Array | null;

function normalizeSqlValue(value: unknown): SqlValue {
  if (value === null || typeof value === "string" || typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("SQL parameters must be finite numbers");
    }
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new Error("SQL parameters must be strings, numbers, bigints, booleans, binary values, or null");
}

function requireOptions(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, fallback: number | undefined, name: string): number {
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function queryOrder(value: unknown): "ASC" | "DESC" {
  if (value === undefined || value === "desc") {
    return "DESC";
  }
  if (value === "asc") {
    return "ASC";
  }
  throw new Error("order must be asc or desc");
}

function parseUnixTime(value: unknown, name: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return Math.trunc(numeric);
    }
    const millis = Date.parse(value);
    if (!Number.isNaN(millis)) {
      return Math.trunc(millis / 1000);
    }
  }
  throw new Error(`${name} must be Unix seconds or an ISO-8601 timestamp`);
}

function normalizeJsonValue(value: unknown, seen = new Set<object>(), path = "result"): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return { encoding: "base64", data: Buffer.from(value).toString("base64") };
  }
  if (value instanceof ArrayBuffer) {
    return { encoding: "base64", data: Buffer.from(value).toString("base64") };
  }
  if (typeof value !== "object" || value === undefined) {
    throw new Error(`${path} is not JSON-serializable`);
  }
  if (seen.has(value)) {
    throw new Error(`${path} contains a circular reference`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => normalizeJsonValue(item, seen, `${path}[${index}]`));
    }
    const normalized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      normalized[key] = normalizeJsonValue(item, seen, `${path}.${key}`);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

async function runChild(): Promise<void> {
  process.once("message", async (request: QueryRequest) => {
    let response: QueryResponse;
    try {
      response = { ok: true, result: await executeQuery(request) };
    } catch (err) {
      response = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!process.send) {
      process.exitCode = 1;
      return;
    }
    process.send(response, undefined, undefined, () => {
      if (process.connected) {
        process.disconnect?.();
      }
    });
  });
}

if (process.env.ASTRAL_BRIDGE_MESSAGE_QUERY_CHILD === "1") {
  void runChild();
}
