import type {
  ExternalEvent,
  GroupInfo,
  MessageSegment,
  OneBotMessageEvent,
  Platform,
  SourceType,
  StoredAttachment,
  StoredMessage,
  TriggerKind,
} from "./types.js";
import { QQ_REACTION_EMOJI_IDS, TELEGRAM_REACTION_EMOJIS } from "./reactions.js";

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

export function textFromSegments(segments: MessageSegment[]): string {
  return segments
    .filter((segment) => segment.type === "text")
    .map((segment) => String(segment.data?.text ?? ""))
    .join("")
    .trim();
}

export function rawText(event: OneBotMessageEvent, segments: MessageSegment[]): string {
  return event.raw_message ?? textFromSegments(segments);
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
          return `[CQ:image,file=${String(data.file ?? data.url ?? "")}]`;
        case "file":
          return `[CQ:file,file=${String(data.file ?? data.name ?? "")}]`;
        default:
          return `[${segment.type}]`;
      }
    })
    .join("");
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
  if (message.replyToMessageId) {
    lines.push(`reply_to_message_id: ${message.replyToMessageId}`);
  }

  if (message.conversationUnread) {
    lines.push("");
    lines.push("conversation_unread:");
    lines.push(`unread_count: ${message.conversationUnread.unreadCount}`);
    lines.push(
      "note: unread_count is the number of stored QQ messages in this same conversation since the previous Astral prompt, including the current message. When you need that surrounding context, qq_get_unread_messages returns this unread batch and returns up to 100 messages by default.",
    );
  }

  lines.push("");
  lines.push("content:");
  lines.push(message.rawMessage || message.text || "[non-text message]");

  if (message.attachments.length > 0) {
    lines.push("");
    lines.push("attachments:");
    for (const [index, attachment] of message.attachments.entries()) {
      const label = attachment.name ?? attachment.fileId ?? attachment.url ?? "unnamed";
      lines.push(`- index: ${index}`);
      lines.push(`  kind: ${attachment.kind}`);
      lines.push(`  label: ${label}`);
      if (attachment.url) {
        lines.push(`  url: ${attachment.url}`);
      }
      if (attachment.fileId) {
        lines.push(`  file_id: ${attachment.fileId}`);
      }
    }
  }

  lines.push("");
  lines.push("history:");
  lines.push(
    "Use QQ MCP tools mcp__qq__qq_get_unread_messages, mcp__qq__qq_get_recent_messages, mcp__qq__qq_get_message, mcp__qq__qq_search_messages, or mcp__qq__qq_download_media when you need more QQ context or media content.",
  );
  lines.push("");
  lines.push("reply_policy:");
  lines.push(
    "Normally reply to this QQ message by calling a QQ MCP send tool in the same channel it came from. Do not only output plain text: plain text is not sent to QQ, so the sender will not see it. For group messages call mcp__qq__qq_send_group_message with group_id; for private messages call mcp__qq__qq_send_private_message with sender_user_id.",
  );
  lines.push(
    "To send an image, create or reuse an image file under /workspace or /app/media, then call mcp__qq__qq_send_group_message or mcp__qq__qq_send_private_message with images: [\"/workspace/example.png\"] and optional message text. Do not just print the image path or a Markdown image; QQ users will not receive it.",
  );
  lines.push(
    "To mention people inside a group message, use mcp__qq__qq_send_group_message parts in the exact order you want: {type:\"text\",text:\"...\"}, {type:\"at\",user_id:\"...\"}, {type:\"image\",file:\"/workspace/example.png\"}. Split surrounding text into separate text parts so @mentions can appear in the middle or multiple places. If you use both parts and message, parts are sent first and message is appended as the full body.",
  );
  lines.push(
    "To reply to a specific QQ message, pass reply_to_message_id to mcp__qq__qq_send_group_message or mcp__qq__qq_send_private_message. You can get message ids from the current inbound message_id, mcp__qq__qq_get_recent_messages, mcp__qq__qq_get_message, or mcp__qq__qq_search_messages.",
  );
  lines.push(
    `When a lightweight acknowledgement is enough, you may react to a QQ group message instead of sending text by calling mcp__qq__qq_set_reaction with message_id and emoji_id. QQ reactions only work in group chats. Available/common emoji_id values: ${QQ_REACTION_EMOJI_IDS}.`,
  );
  lines.push(
    "To send a non-image file, create or reuse the file under /workspace or /app/media, then call mcp__qq__qq_send_group_file with group_id and file, or mcp__qq__qq_send_private_file with user_id and file. Use the name argument when you want a friendly filename.",
  );
  lines.push(
    "Examples: mixed group reply => mcp__qq__qq_send_group_message({ group_id, reply_to_message_id: message_id, parts: [{type:\"text\",text:\"收到 \"},{type:\"at\",user_id:sender_user_id},{type:\"text\",text:\"，我也请 \"},{type:\"at\",user_id:\"123456\"},{type:\"text\",text:\" 看一下\"}] }); private file => mcp__qq__qq_send_private_file({ user_id: sender_user_id, file: \"/workspace/result.zip\", name: \"result.zip\" }).",
  );
  lines.push(
    "When writing tool string arguments, avoid raw unescaped double quotes inside strings; use Chinese corner quotes like 「...」 or escape quotes so the tool call stays valid JSON.",
  );

  return lines.join("\n");
}

function buildTelegramAstralPrompt(message: StoredMessage): string {
  const raw = isRecord(message.rawEvent) ? message.rawEvent : {};
  const chat = isRecord(raw.chat) ? raw.chat : {};
  const from = isRecord(raw.from) ? raw.from : {};
  const entities = Array.isArray(raw.entities) ? raw.entities : [];
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
  }

  if (message.conversationUnread) {
    lines.push("");
    lines.push("conversation_unread:");
    lines.push(`unread_count: ${message.conversationUnread.unreadCount}`);
    lines.push(
      "note: unread_count is the number of stored Telegram messages in this same chat since the previous Astral prompt, including the current message. When you need that surrounding context, telegram_get_unread_messages returns this unread batch and returns up to 100 messages by default.",
    );
  }

  lines.push("");
  lines.push("content:");
  lines.push(message.rawMessage || message.text || "[non-text message]");

  if (entities.length > 0) {
    lines.push("");
    lines.push("entities:");
    lines.push(JSON.stringify(entities, null, 2));
  }

  if (message.attachments.length > 0) {
    lines.push("");
    lines.push("attachments:");
    for (const [index, attachment] of message.attachments.entries()) {
      const label = attachment.name ?? attachment.fileId ?? attachment.url ?? "unnamed";
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
  lines.push("history:");
  lines.push(
    "Use Telegram MCP tools mcp__telegram__telegram_get_unread_messages, mcp__telegram__telegram_get_recent_messages, mcp__telegram__telegram_get_message, mcp__telegram__telegram_search_messages, or mcp__telegram__telegram_download_media when you need more Telegram context or media content.",
  );
  lines.push("");
  lines.push("reply_policy:");
  lines.push(
    "Normally reply to this Telegram message by calling a Telegram MCP send tool in the same chat it came from. Do not only output plain text: plain text is not sent to Telegram, so the sender will not see it.",
  );
  lines.push(
    "For text replies call mcp__telegram__telegram_send_message with chat_id and optional reply_to_message_id. If message_thread_id is present, pass it so the reply stays in the same topic.",
  );
  lines.push(
    "To send images or any non-text file, create or reuse a file under /workspace or /app/media, then call mcp__telegram__telegram_send_file with chat_id, file, optional caption, and optional reply_to_message_id. Images are intentionally sent as files/documents to preserve quality.",
  );
  lines.push(
    "To mention people, use telegram_send_message parts in the exact order you want: {type:\"text\",text:\"...\"}, {type:\"mention\",username:\"alice\"}, or {type:\"mention\",user_id:\"123456\",text:\"Alice\"}. Use user_id mentions only when the user id is known.",
  );
  lines.push(
    "To delete a Telegram message, call mcp__telegram__telegram_delete_message with chat_id and message_id. Telegram may reject deletion if the bot lacks admin permission or the message is outside Telegram's deletion rules.",
  );
  lines.push(
    `When a lightweight acknowledgement is enough, you may react instead of sending text by calling mcp__telegram__telegram_set_reaction with chat_id, message_id, and emoji. Telegram reactions work in both private and group chats. Available emoji: ${TELEGRAM_REACTION_EMOJIS}.`,
  );
  lines.push(
    "When writing tool string arguments, avoid raw unescaped double quotes inside strings; use Chinese corner quotes like 「...」 or escape quotes so the tool call stays valid JSON.",
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
