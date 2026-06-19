import type {
  GroupInfo,
  MessageSegment,
  OneBotMessageEvent,
  SourceType,
  StoredAttachment,
  StoredMessage,
  TriggerKind,
} from "./types.js";

export function normalizeSegments(message: MessageSegment[] | string): MessageSegment[] {
  if (Array.isArray(message)) {
    return message;
  }
  return [{ type: "text", data: { text: message } }];
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
    const name = firstString(data, ["name", "file_name", "filename"]);
    return [
      {
        kind: segment.type,
        fileId: firstString(data, ["file_id", "file", "id"]),
        name,
        url: firstString(data, ["url"]),
        path: null,
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
  const targetId = sourceType === "group" ? String(event.group_id) : String(event.user_id);
  const sender = event.sender ?? {};

  return {
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

export function buildAstralPrompt(message: StoredMessage): string {
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
    "Use MCP tools qq_get_unread_messages, qq_get_recent_messages, qq_get_message, qq_search_messages, or qq_download_media when you need more QQ context or media content.",
  );
  lines.push("");
  lines.push("reply_policy:");
  lines.push(
    "Normally reply to this QQ message by calling a qq MCP send tool in the same channel it came from. Do not only output plain text: plain text is not sent to QQ, so the sender will not see it. For group messages call qq_send_group_message with group_id; for private messages call qq_send_private_message with sender_user_id.",
  );
  lines.push(
    "To send an image, create or reuse an image file under /workspace or /app/media, then call qq_send_group_message or qq_send_private_message with images: [\"/workspace/example.png\"] and optional message text. Do not just print the image path or a Markdown image; QQ users will not receive it.",
  );
  lines.push(
    "To mention people inside a group message, use qq_send_group_message parts in the exact order you want: {type:\"text\",text:\"...\"}, {type:\"at\",user_id:\"...\"}, {type:\"image\",file:\"/workspace/example.png\"}. Split surrounding text into separate text parts so @mentions can appear in the middle or multiple places.",
  );
  lines.push(
    "To reply to a specific QQ message, pass reply_to_message_id to qq_send_group_message or qq_send_private_message. You can get message ids from the current inbound message_id, qq_get_recent_messages, qq_get_message, or qq_search_messages.",
  );
  lines.push(
    "To send a non-image file, create or reuse the file under /workspace or /app/media, then call qq_send_group_file with group_id and file, or qq_send_private_file with user_id and file. Use the name argument when you want a friendly filename.",
  );
  lines.push(
    "Examples: mixed group reply => qq_send_group_message({ group_id, reply_to_message_id: message_id, parts: [{type:\"text\",text:\"收到 \"},{type:\"at\",user_id:sender_user_id},{type:\"text\",text:\"，我也请 \"},{type:\"at\",user_id:\"123456\"},{type:\"text\",text:\" 看一下\"}] }); private file => qq_send_private_file({ user_id: sender_user_id, file: \"/workspace/result.zip\", name: \"result.zip\" }).",
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
