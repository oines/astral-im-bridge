import {
  attachmentsFromSegments,
  historyTextFromSegments,
  sanitizeCqMessage,
} from "./message.js";
import type { MessageSegment, StoredAttachment } from "./types.js";

export interface QqForwardNode {
  nodePath: string;
  depth: number;
  senderUserId: string | null;
  senderDisplayName: string | null;
  timeUnix: number | null;
  text: string;
  attachments: StoredAttachment[];
  unsupportedSegmentTypes: string[];
}

export interface QqForwardExpansion {
  nodes: QqForwardNode[];
  warnings: string[];
}

export type QqForwardFetcher = (messageId: string) => Promise<unknown[]>;

const KNOWN_SEGMENT_TYPES = new Set([
  "text",
  "at",
  "reply",
  "image",
  "file",
  "onlinefile",
  "record",
  "voice",
  "video",
  "forward",
  "face",
  "mface",
  "marketface",
  "emoji",
  "json",
  "xml",
  "dice",
  "rps",
  "shake",
  "poke",
  "music",
  "location",
  "share",
  "contact",
  "markdown",
  "keyboard",
]);

export async function expandQqForwardMessages(
  messageId: string,
  fetchForward: QqForwardFetcher,
): Promise<QqForwardExpansion> {
  const normalizedId = messageId.trim();
  if (!normalizedId) {
    throw new Error("forward message_id must not be empty");
  }

  const nodes: QqForwardNode[] = [];
  const warnings: string[] = [];
  const visitedIds = new Set<string>([normalizedId]);
  const root = normalizeForwardNodeList(await fetchForward(normalizedId));
  await appendNodes(root, "", 0);
  return { nodes, warnings };

  async function appendNodes(
    rawNodes: unknown[],
    parentPath: string,
    depth: number,
    startingIndex = 0,
  ): Promise<void> {
    for (const [index, rawNode] of rawNodes.entries()) {
      const nodePath = parentPath
        ? `${parentPath}/${startingIndex + index}`
        : String(startingIndex + index);
      const normalized = normalizeForwardNode(rawNode, nodePath, depth);
      nodes.push(normalized.node);

      let childOffset = 0;
      for (const segment of normalized.segments) {
        if (segment.type !== "forward") {
          continue;
        }
        const data = segment.data ?? {};
        const nestedId = firstString(data, ["id", "message_id", "resid"]);
        const inlineNodes = inlineForwardNodes(data);

        if (nestedId && visitedIds.has(nestedId)) {
          warnings.push(`Skipped cyclic or repeated forward ${nestedId} at node ${nodePath}`);
          continue;
        }
        if (nestedId) {
          visitedIds.add(nestedId);
        }

        if (inlineNodes) {
          await appendNodes(inlineNodes, nodePath, depth + 1, childOffset);
          childOffset += inlineNodes.length;
          continue;
        }
        if (!nestedId) {
          warnings.push(`Nested forward at node ${nodePath} has no id or inline content`);
          continue;
        }

        try {
          const fetched = normalizeForwardNodeList(await fetchForward(nestedId));
          await appendNodes(fetched, nodePath, depth + 1, childOffset);
          childOffset += fetched.length;
        } catch (err) {
          warnings.push(`Failed to expand nested forward ${nestedId} at node ${nodePath}: ${errorMessage(err)}`);
        }
      }
    }
  }
}

export function normalizeForwardNodeList(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  if (value.length === 0) {
    return [];
  }
  if (value.every(isMessageSegment)) {
    if (value.every((item) => item.type === "node")) {
      return value;
    }
    return [{ message: value }];
  }
  return value;
}

export function findQqForwardNode(
  expansion: QqForwardExpansion,
  nodePath: string,
): QqForwardNode | null {
  const normalized = normalizeNodePath(nodePath);
  return expansion.nodes.find((node) => node.nodePath === normalized) ?? null;
}

function normalizeForwardNode(
  value: unknown,
  nodePath: string,
  depth: number,
): { node: QqForwardNode; segments: MessageSegment[] } {
  const outer = asRecord(value);
  const record = outer.type === "node" && isRecord(outer.data)
    ? outer.data
    : outer;
  const sender = asRecord(record.sender);
  const segments = segmentsFromValue(
    record.message
      ?? record.content
      ?? record.message_chain
      ?? record.messageChain
      ?? record.raw_message
      ?? "",
  );
  const rawMessage = firstString(record, ["raw_message", "rawMessage"]);
  const text = sanitizeCqMessage(rawMessage ?? historyTextFromSegments(segments)).trim();
  const senderUserId = firstString(sender, ["user_id", "uin", "id"])
    ?? firstString(record, ["user_id", "uin", "sender_id"]);
  const senderDisplayName = firstString(sender, ["card", "nickname", "name"])
    ?? firstString(record, ["nickname", "name", "sender_name"])
    ?? senderUserId;

  return {
    node: {
      nodePath,
      depth,
      senderUserId,
      senderDisplayName,
      timeUnix: firstNumber(record, ["time", "time_unix", "timestamp"]),
      text,
      attachments: attachmentsFromSegments(segments),
      unsupportedSegmentTypes: [...new Set(
        segments
          .map((segment) => segment.type)
          .filter((type) => !KNOWN_SEGMENT_TYPES.has(type)),
      )],
    },
    segments,
  };
}

function segmentsFromValue(value: unknown): MessageSegment[] {
  if (typeof value === "string") {
    return segmentsFromCqString(value);
  }
  if (Array.isArray(value)) {
    return value.filter(isMessageSegment);
  }
  if (isRecord(value)) {
    return segmentsFromValue(value.message ?? value.content ?? "");
  }
  return [];
}

function segmentsFromCqString(value: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const pattern = /\[CQ:([a-zA-Z0-9_]+)(?:,([^\]]*))?\]/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ type: "text", data: { text: decodeCq(value.slice(cursor, index)) } });
    }
    const data: Record<string, unknown> = {};
    if (match[2]) {
      for (const entry of match[2].split(",")) {
        const equals = entry.indexOf("=");
        if (equals < 0) {
          continue;
        }
        data[entry.slice(0, equals)] = decodeCq(entry.slice(equals + 1));
      }
    }
    segments.push({ type: match[1], data });
    cursor = index + match[0].length;
  }
  if (cursor < value.length) {
    segments.push({ type: "text", data: { text: decodeCq(value.slice(cursor)) } });
  }
  return segments.length > 0 ? segments : [{ type: "text", data: { text: value } }];
}

function decodeCq(value: string): string {
  return value
    .replace(/&#44;/g, ",")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&amp;/g, "&");
}

function inlineForwardNodes(data: Record<string, unknown>): unknown[] | null {
  for (const key of ["content", "messages", "message"]) {
    const value = data[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const normalized = normalizeForwardNodeList(value);
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return null;
}

function normalizeNodePath(value: string): string {
  const normalized = value.trim().replace(/^\/+|\/+$/g, "");
  if (!/^\d+(?:\/\d+)*$/.test(normalized)) {
    throw new Error("forward_node_path must contain zero-based indexes such as 4/1");
  }
  return normalized;
}

function isMessageSegment(value: unknown): value is MessageSegment {
  return isRecord(value) && typeof value.type === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (value == null) {
      continue;
    }
    const text = String(value).trim();
    if (text) {
      return text;
    }
  }
  return null;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
