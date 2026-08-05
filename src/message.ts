import { randomUUID } from "node:crypto";
import type {
  ExternalEvent,
  GroupInfo,
  MessageSegment,
  OneBotMessageEvent,
  OneBotPokeNoticeEvent,
  Platform,
  SourceType,
  StoredAttachment,
  StoredMessage,
  TriggerKind,
} from "./types.js";
import { extractTelegramReplyQuote } from "./telegram_quote.js";

interface OutboundStoredMessageOptions {
  platform: Platform;
  platformMessageId: string;
  sourceType: SourceType;
  targetId: string;
  groupInfo: GroupInfo | null;
  botUserId: string;
  botNickname?: string;
  segments: MessageSegment[];
  replyToMessageId?: string | null;
  action: string;
  response: unknown;
}

export function normalizeSegments(message: MessageSegment[] | string): MessageSegment[] {
  if (Array.isArray(message)) {
    return message;
  }
  return [{ type: "text", data: { text: message } }];
}

export function targetIdFromEvent(event: OneBotMessageEvent): string {
  if (event.message_type === "group") {
    return String(event.group_id);
  }
  return String(event.target_id ?? event.user_id);
}

export function pokeSourceType(event: OneBotPokeNoticeEvent): SourceType {
  return event.group_id == null ? "private" : "group";
}

export function pokeTargetId(event: OneBotPokeNoticeEvent): string {
  return event.group_id == null ? String(event.user_id) : String(event.group_id);
}

export function textFromSegments(segments: MessageSegment[]): string {
  return segments
    .filter((segment) => segment.type === "text")
    .map((segment) => String(segment.data?.text ?? ""))
    .join("")
    .trim();
}

export function rawText(event: OneBotMessageEvent, segments: MessageSegment[]): string {
  return sanitizeCqMessage(event.raw_message ?? historyTextFromSegments(segments));
}

export function sanitizeCqMessage(rawMessage: string): string {
  return rawMessage.replace(/\[CQ:([a-zA-Z0-9_]+)(?:,([^\]]*))?\]/g, (match, type: string, body?: string) => {
    if (!body) {
      return match;
    }
    const params = body
      .split(",")
      .map((part) => sanitizeCqParam(part))
      .filter((part): part is string => part != null && part.length > 0);
    return params.length > 0 ? `[CQ:${type},${params.join(",")}]` : `[CQ:${type}]`;
  });
}

function sanitizeCqParam(param: string): string | null {
  const equalsIndex = param.indexOf("=");
  const key = (equalsIndex >= 0 ? param.slice(0, equalsIndex) : param).trim();
  const value = equalsIndex >= 0 ? param.slice(equalsIndex + 1) : "";
  const normalizedKey = key.toLowerCase();
  if (["url", "file_url", "thumb_url", "preview"].includes(normalizedKey)) {
    return null;
  }
  if (["file", "id", "name"].includes(normalizedKey) && /^https?:\/\//i.test(value)) {
    return `${key}=remote`;
  }
  return param;
}

export function historyTextFromSegments(segments: MessageSegment[]): string {
  return segments
    .map((segment) => {
      const data = segment.data ?? {};
      switch (segment.type) {
        case "text":
          return String(data.text ?? "");
        case "at":
          return `[CQ:at,qq=${String(data.qq ?? "")}]`;
        case "reply":
          return `[CQ:reply,id=${String(data.id ?? data.message_id ?? "")}]`;
        case "image":
          return `[CQ:image,file=${safeMediaLabel(data.file ?? data.id)}]`;
        case "file":
          return `[CQ:file,file=${safeMediaLabel(data.file ?? data.name)}]`;
        default:
          return `[${segment.type}]`;
      }
    })
    .join("");
}

function safeMediaLabel(value: unknown): string {
  const label = String(value ?? "").trim();
  return /^https?:\/\//i.test(label) ? "remote" : label;
}

export function isAtBot(segments: MessageSegment[], botUserId: string): boolean {
  return segments.some((segment) => {
    if (segment.type !== "at") {
      return false;
    }
    return String(segment.data?.qq ?? "") === botUserId;
  });
}

export function replySegmentMessageId(segments: MessageSegment[]): string | null {
  const reply = segments.find((segment) => segment.type === "reply");
  const id = reply?.data?.id ?? reply?.data?.message_id;
  return id == null ? null : String(id);
}

export function replyMessageIdFromEvent(
  event: OneBotMessageEvent,
  segments = normalizeSegments(event.message),
): string | null {
  return replySegmentMessageId(segments)
    ?? replyMessageIdFromRaw(event.raw_message)
    ?? replyMessageIdFromRaw(typeof event.message === "string" ? event.message : null)
    ?? replyMessageIdFromExtensionFields(event);
}

function replyMessageIdFromRaw(rawMessage: string | null | undefined): string | null {
  if (!rawMessage) {
    return null;
  }
  const match = rawMessage.match(/\[CQ:reply,(?:[^\]]*,)?(?:id|message_id)=([^,\]]+)/i);
  return normalizeReplyId(match?.[1]);
}

function replyMessageIdFromExtensionFields(event: OneBotMessageEvent): string | null {
  const direct = firstReplyId(event, [
    "reply_to_message_id",
    "replyToMessageId",
    "reply_message_id",
    "replyMessageId",
    "source_message_id",
    "sourceMessageId",
    "quoted_message_id",
    "quotedMessageId",
  ]);
  if (direct) {
    return direct;
  }

  for (const key of [
    "reply",
    "reply_message",
    "replyMessage",
    "quote",
    "quoted",
    "source",
    "source_message",
    "sourceMessage",
  ]) {
    const nested = event[key];
    if (typeof nested !== "object" || nested === null) {
      continue;
    }
    const id = firstReplyId(nested as Record<string, unknown>, [
      "id",
      "message_id",
      "messageId",
      "reply_to_message_id",
      "replyToMessageId",
      "source_message_id",
      "sourceMessageId",
    ]);
    if (id) {
      return id;
    }
  }

  return null;
}

function firstReplyId(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const id = normalizeReplyId(source[key]);
    if (id) {
      return id;
    }
  }
  return null;
}

function normalizeReplyId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    return null;
  }
  const id = String(value).trim();
  return id.length > 0 ? id : null;
}

export function attachmentsFromSegments(segments: MessageSegment[]): StoredAttachment[] {
  return segments.flatMap((segment) => {
    if (!["image", "file", "record", "video"].includes(segment.type)) {
      return [];
    }
    const data = segment.data ?? {};
    const file = firstString(data, ["file"]);
    const path = firstString(data, ["path"]) ?? (file?.startsWith("/") ? file : null);
    const name = firstString(data, ["name", "file_name", "filename"]);
    return [
      {
        kind: segment.type,
        fileId: firstString(data, ["file_id", "id"]) ?? (path ? null : file),
        name,
        url: firstString(data, ["url"]),
        path,
        mimeType: firstString(data, ["mime_type", "mime"]),
        size: firstNumber(data, ["size", "file_size"]),
        raw: segment,
      },
    ];
  });
}

export function buildStoredMessage(
  event: OneBotMessageEvent,
  groupInfo: GroupInfo | null,
  trigger: TriggerKind,
  replyToMessageId: string | null,
): StoredMessage {
  const segments = normalizeSegments(event.message);
  const sourceType = event.message_type as SourceType;
  const groupId = event.group_id == null ? null : String(event.group_id);
  const targetId = targetIdFromEvent(event);
  const sender = event.sender ?? {};

  return {
    platform: "qq",
    platformMessageId: String(event.message_id),
    sourceType,
    targetId,
    groupId,
    groupName: groupInfo?.group_name ?? null,
    userId: String(sender.user_id ?? event.user_id),
    nickname: nullIfEmpty(sender.nickname),
    groupCard: nullIfEmpty(sender.card),
    role: nullIfEmpty(sender.role),
    time: event.time ?? Math.floor(Date.now() / 1000),
    text: textFromSegments(segments),
    rawMessage: rawText(event, segments),
    trigger,
    replyToMessageId,
    rawEvent: event,
    attachments: attachmentsFromSegments(segments),
  };
}

export function buildPokeStoredMessage(
  event: OneBotPokeNoticeEvent,
  groupInfo: GroupInfo | null,
  trigger: Extract<TriggerKind, "group_poke" | "private_poke" | "none">,
  botUserId: string,
): StoredMessage {
  const sourceType = pokeSourceType(event);
  const targetId = pokeTargetId(event);
  const groupId = event.group_id == null ? null : String(event.group_id);
  const userId = String(event.user_id);
  const targetUserId = String(event.target_id);
  const time = event.time ?? Math.floor(Date.now() / 1000);
  const sender = event.sender ?? {};
  const target = targetUserId === botUserId ? "bot" : `user ${targetUserId}`;
  const text = sourceType === "group"
    ? `[poke] user ${userId} poked ${target} in group ${targetId}`
    : `[poke] user ${userId} poked ${target} in private chat`;

  return {
    platform: "qq",
    platformMessageId: pokePlatformMessageId(event, sourceType, targetId),
    sourceType,
    targetId,
    groupId,
    groupName: groupInfo?.group_name ?? null,
    userId,
    nickname: nullIfEmpty(sender.nickname),
    groupCard: nullIfEmpty(sender.card),
    role: nullIfEmpty(sender.role),
    time,
    text,
    rawMessage: text,
    trigger,
    replyToMessageId: null,
    rawEvent: {
      ...event,
      bridge_event_type: "poke",
      bridge_synthetic_message_id: true,
      poke_target_user_id: targetUserId,
    },
    attachments: [],
  };
}

function pokePlatformMessageId(
  event: OneBotPokeNoticeEvent,
  sourceType: SourceType,
  targetId: string,
): string {
  const eventRecord = event as Record<string, unknown>;
  const explicitId = firstString(eventRecord, ["message_id", "messageId", "event_id", "eventId"]);
  if (explicitId) {
    return explicitId;
  }
  return [
    "poke",
    sourceType,
    targetId,
    String(event.user_id),
    String(event.target_id),
    String(event.time ?? Math.floor(Date.now() / 1000)),
    randomUUID(),
  ].join(":");
}

export function buildOutboundStoredMessage(options: OutboundStoredMessageOptions): StoredMessage {
  const groupId = options.sourceType === "group" ? options.targetId : null;
  const rawMessage = historyTextFromSegments(options.segments);
  const time = Math.floor(Date.now() / 1000);
  return {
    platform: options.platform,
    platformMessageId: options.platformMessageId,
    sourceType: options.sourceType,
    targetId: options.targetId,
    groupId,
    groupName: options.groupInfo?.group_name ?? null,
    userId: options.botUserId,
    nickname: options.botNickname ?? "Astral",
    groupCard: options.botNickname ?? "Astral",
    role: options.sourceType === "group" ? "bot" : null,
    time,
    text: textFromSegments(options.segments),
    rawMessage,
    trigger: "bot_message",
    replyToMessageId: options.replyToMessageId ?? replySegmentMessageId(options.segments),
    rawEvent: {
      post_type: "message_sent",
      message_type: options.sourceType,
      message_id: options.platformMessageId,
      self_id: options.botUserId,
      user_id: options.botUserId,
      target_id: options.sourceType === "private" ? options.targetId : undefined,
      group_id: groupId ?? undefined,
      sender: {
        user_id: options.botUserId,
        nickname: options.botNickname ?? "Astral",
        card: options.botNickname ?? "Astral",
        role: options.sourceType === "group" ? "bot" : undefined,
      },
      raw_message: rawMessage,
      message: options.segments,
      time,
      bridge_outbound: true,
      action: options.action,
      response: options.response,
    },
    attachments: attachmentsFromSegments(options.segments),
  };
}

export function buildAstralPrompt(message: StoredMessage): string {
  if (message.platform === "telegram") {
    return buildTelegramAstralPrompt(message);
  }
  return buildQqAstralPrompt(message);
}

function buildQqAstralPrompt(message: StoredMessage): string {
  const isPoke = isQqPokeMessage(message);
  const lines = [
    "[QQ inbound message]",
    `platform: onebot_v11 / napcat`,
    `source_type: ${message.sourceType}`,
  ];
  if (message.sourceType === "group") {
    lines.push(`group_id: ${message.groupId ?? ""}`);
    lines.push(`group_name: ${message.groupName ?? ""}`);
  }
  lines.push(`sender_user_id: ${message.userId}`);
  lines.push(`sender_nickname: ${message.nickname ?? ""}`);
  if (message.sourceType === "group") {
    lines.push(`sender_group_card: ${message.groupCard ?? ""}`);
    lines.push(`sender_role: ${message.role ?? ""}`);
  }
  lines.push(`message_id: ${message.platformMessageId}`);
  lines.push(`time_unix: ${message.time}`);
  lines.push(`trigger: ${message.trigger}`);
  if (isPoke) {
    lines.push("event_type: poke");
    lines.push("message_id_is_synthetic: true");
  }
  if (message.replyToMessageId) {
    lines.push(`reply_to_message_id: ${message.replyToMessageId}`);
  }

  if (message.conversationUnread) {
    lines.push(`conversation_unread_count: ${message.conversationUnread.unreadCount}`);
  }

  lines.push("");
  lines.push("content:");
  lines.push(message.rawMessage || message.text || "[non-text message]");

  if (message.attachments.length > 0) {
    lines.push("");
    lines.push("attachments:");
    for (const [index, attachment] of message.attachments.entries()) {
      const label = attachment.name ?? attachment.fileId ?? (attachment.url ? "remote_media" : "unnamed");
      lines.push(`- index: ${index}`);
      lines.push(`  kind: ${attachment.kind}`);
      lines.push(`  label: ${label}`);
      if (attachment.url) {
        lines.push("  has_remote_url: true");
      }
      if (attachment.fileId) {
        lines.push(`  file_id: ${attachment.fileId}`);
      }
    }
  }

  lines.push("");
  lines.push("delivery:");
  lines.push(
    "Reply through the matching QQ MCP tool for this group or private conversation; ordinary assistant text is not delivered to QQ.",
  );
  if (isPoke) {
    lines.push(
      "This poke event has a synthetic message_id; do not use it as reply_to_message_id.",
    );
  }

  return lines.join("\n");
}

function isQqPokeMessage(message: StoredMessage): boolean {
  if (message.platform !== "qq") {
    return false;
  }
  if (message.trigger !== "group_poke" && message.trigger !== "private_poke") {
    return false;
  }
  const raw = isRecord(message.rawEvent) ? message.rawEvent : {};
  return raw.bridge_event_type === "poke" || raw.sub_type === "poke";
}

function buildTelegramAstralPrompt(message: StoredMessage): string {
  const raw = isRecord(message.rawEvent) ? message.rawEvent : {};
  const chat = isRecord(raw.chat) ? raw.chat : {};
  const from = isRecord(raw.from) ? raw.from : {};
  const threadId = raw.message_thread_id == null ? null : String(raw.message_thread_id);
  const lines = [
    "[Telegram inbound message]",
    "platform: telegram",
    `source_type: ${message.sourceType}`,
    `chat_id: ${message.targetId}`,
    `chat_type: ${String(chat.type ?? message.sourceType)}`,
    `chat_title: ${message.groupName ?? ""}`,
  ];
  if (threadId) {
    lines.push(`message_thread_id: ${threadId}`);
  }
  lines.push(`sender_user_id: ${message.userId}`);
  lines.push(`sender_username: ${String(from.username ?? "")}`);
  lines.push(`sender_display_name: ${message.nickname ?? ""}`);
  lines.push(`message_id: ${message.platformMessageId}`);
  lines.push(`time_unix: ${message.time}`);
  lines.push(`trigger: ${message.trigger}`);
  if (message.replyToMessageId) {
    lines.push(`reply_to_message_id: ${message.replyToMessageId}`);
    const quote = extractTelegramReplyQuote(message.rawEvent);
    if (quote) {
      lines.push("reply_quote:");
      lines.push(`text: ${quote.text}`);
      if (quote.position_utf16 != null) {
        lines.push(`position_utf16: ${quote.position_utf16}`);
      }
      if (quote.is_manual != null) {
        lines.push(`is_manual: ${quote.is_manual}`);
      }
    }
  }

  if (message.conversationUnread) {
    lines.push(`conversation_unread_count: ${message.conversationUnread.unreadCount}`);
  }

  lines.push("");
  lines.push("content:");
  lines.push(message.rawMessage || message.text || "[non-text message]");

  if (message.attachments.length > 0) {
    lines.push("");
    lines.push("attachments:");
    for (const [index, attachment] of message.attachments.entries()) {
      const label = attachment.name ?? attachment.fileId ?? (attachment.url ? "remote_media" : "unnamed");
      lines.push(`- index: ${index}`);
      lines.push(`  kind: ${attachment.kind}`);
      lines.push(`  label: ${label}`);
      if (attachment.fileId) {
        lines.push(`  file_id: ${attachment.fileId}`);
      }
      if (attachment.mimeType) {
        lines.push(`  mime_type: ${attachment.mimeType}`);
      }
      if (attachment.size != null) {
        lines.push(`  size: ${attachment.size}`);
      }
    }
  }

  lines.push("");
  lines.push("delivery:");
  lines.push(
    "Reply through the matching Telegram MCP tool for this chat; ordinary assistant text is not delivered to Telegram. Preserve message_thread_id when present.",
  );

  return lines.join("\n");
}

export function buildExternalEventPrompt(event: ExternalEvent): string {
  const lines = [
    "[External event]",
    `source: ${event.source}`,
    `event_type: ${event.eventType}`,
    `event_id: ${event.id}`,
    `severity: ${event.severity}`,
    `occurred_at: ${event.occurredAt}`,
    `received_at: ${event.receivedAt}`,
  ];
  if (event.title) {
    lines.push(`title: ${event.title}`);
  }
  if (event.dedupeKey) {
    lines.push(`dedupe_key: ${event.dedupeKey}`);
  }

  if (event.actor != null) {
    lines.push("");
    lines.push("actor:");
    lines.push(JSON.stringify(event.actor, null, 2));
  }

  if (Object.keys(event.metadata).length > 0) {
    lines.push("");
    lines.push("metadata:");
    lines.push(JSON.stringify(event.metadata, null, 2));
  }

  lines.push("");
  lines.push("body:");
  lines.push(event.body);
  lines.push("");
  lines.push("event_policy:");
  lines.push(
    "This is an external system event delivered through Astral Bridge. Decide whether it needs action. If you need to notify chat users, call the appropriate QQ or Telegram MCP send tools; plain text output is not visible to chat platforms.",
  );

  return lines.join("\n");
}

function firstString(data: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (value != null && String(value).trim()) {
      return String(value);
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstNumber(data: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function nullIfEmpty(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
}
