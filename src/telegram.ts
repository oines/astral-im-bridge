import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { log, warn } from "./logger.js";
import { writeMediaFile } from "./media.js";
import type {
  MessageSegment,
  SourceType,
  StoredAttachment,
  StoredMessage,
  TelegramConfig,
  TriggerKind,
} from "./types.js";
import type { MessageStore } from "./store.js";

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChatPhoto {
  small_file_id: string;
  small_file_unique_id?: string;
  big_file_id: string;
  big_file_unique_id?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  photo?: TelegramChatPhoto;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  user?: TelegramUser;
  [key: string]: unknown;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
  document?: TelegramDocument;
  animation?: TelegramDocument;
  audio?: TelegramDocument;
  video?: TelegramDocument;
  voice?: TelegramDocument;
  video_note?: TelegramDocument;
  sticker?: TelegramDocument;
  photo?: TelegramPhotoSize[];
  rich_message?: unknown;
  [key: string]: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
  [key: string]: unknown;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface TelegramFile {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}

interface TelegramUserProfilePhotos {
  total_count: number;
  photos: TelegramPhotoSize[][];
}

type TelegramAgent = http.Agent | https.Agent;

export interface TelegramEvents {
  message: [TelegramMessage, TelegramUpdate];
}

export interface TelegramSendMessageOptions {
  chatId: string;
  text: string;
  parseMode?: "HTML";
  replyToMessageId?: string;
  messageThreadId?: string;
}

export interface TelegramSendFileOptions {
  chatId: string;
  file: string;
  caption?: string;
  replyToMessageId?: string;
  messageThreadId?: string;
}

export interface TelegramSendRichMessageOptions {
  chatId: string;
  html?: string;
  markdown?: string;
  replyToMessageId?: string;
  messageThreadId?: string;
  isRtl?: boolean;
  skipEntityDetection?: boolean;
}

export interface TelegramSetReactionOptions {
  chatId: string;
  messageId: string;
  emoji: string;
  isBig?: boolean;
}

export class TelegramClient extends EventEmitter<TelegramEvents> {
  private running = false;
  private pollPromise: Promise<void> | null = null;
  private updateOffset = 0;
  private me: TelegramUser | null = null;
  private readonly pollAgent: TelegramAgent;

  constructor(private readonly config: TelegramConfig) {
    super();
    this.pollAgent = createTelegramAgent(config.apiBaseUrl, 1);
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    this.me = await this.api<TelegramUser>("getMe", {});
    await this.api<boolean>("deleteWebhook", { drop_pending_updates: false }).catch((err) => {
      warn("failed to delete telegram webhook before polling", { error: String(err) });
    });
    this.running = true;
    this.pollPromise = this.pollLoop();
    log("telegram long polling started", {
      botId: this.me.id,
      username: this.botUsername(),
      timeoutSeconds: this.config.pollTimeoutSeconds,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.pollPromise;
  }

  botUserId(): string {
    return this.me?.id == null ? "" : String(this.me.id);
  }

  botUsername(): string {
    return (this.me?.username ?? this.config.botUsername).replace(/^@/, "");
  }

  status(): Record<string, unknown> {
    return {
      enabled: this.config.enabled,
      polling: this.running,
      botId: this.botUserId() || null,
      botUsername: this.botUsername() || null,
      updateOffset: this.updateOffset,
    };
  }

  async sendMessage(options: TelegramSendMessageOptions): Promise<TelegramMessage> {
    return this.api<TelegramMessage>("sendMessage", {
      chat_id: telegramId(options.chatId),
      text: options.text,
      ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
      ...(options.replyToMessageId ? { reply_parameters: { message_id: telegramId(options.replyToMessageId) } } : {}),
      ...(options.messageThreadId ? { message_thread_id: telegramId(options.messageThreadId) } : {}),
    });
  }

  async sendFile(options: TelegramSendFileOptions): Promise<TelegramMessage> {
    const params: Record<string, unknown> = {
      chat_id: telegramId(options.chatId),
      ...(options.caption ? { caption: options.caption } : {}),
      ...(options.replyToMessageId ? { reply_parameters: { message_id: telegramId(options.replyToMessageId) } } : {}),
      ...(options.messageThreadId ? { message_thread_id: telegramId(options.messageThreadId) } : {}),
    };

    if (isLocalFile(options.file)) {
      const form = new FormData();
      for (const [key, value] of Object.entries(params)) {
        form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
      const bytes = fs.readFileSync(options.file);
      const blob = new Blob([new Uint8Array(bytes)]);
      form.append("document", blob, path.basename(options.file));
      return this.apiMultipart<TelegramMessage>("sendDocument", form);
    }

    return this.api<TelegramMessage>("sendDocument", {
      ...params,
      document: options.file,
    });
  }

  async sendRichMessage(options: TelegramSendRichMessageOptions): Promise<TelegramMessage> {
    const richMessage: Record<string, unknown> = {
      ...(options.html ? { html: options.html } : {}),
      ...(options.markdown ? { markdown: options.markdown } : {}),
      ...(options.isRtl == null ? {} : { is_rtl: options.isRtl }),
      ...(options.skipEntityDetection == null ? {} : { skip_entity_detection: options.skipEntityDetection }),
    };

    return this.api<TelegramMessage>("sendRichMessage", {
      chat_id: telegramId(options.chatId),
      rich_message: richMessage,
      ...(options.replyToMessageId ? { reply_parameters: { message_id: telegramId(options.replyToMessageId) } } : {}),
      ...(options.messageThreadId ? { message_thread_id: telegramId(options.messageThreadId) } : {}),
    });
  }

  async deleteMessage(chatId: string, messageId: string): Promise<boolean> {
    return this.api<boolean>("deleteMessage", {
      chat_id: telegramId(chatId),
      message_id: telegramId(messageId),
    });
  }

  async setReaction(options: TelegramSetReactionOptions): Promise<boolean> {
    return this.api<boolean>("setMessageReaction", {
      chat_id: telegramId(options.chatId),
      message_id: telegramId(options.messageId),
      reaction: [{ type: "emoji", emoji: options.emoji }],
      ...(options.isBig == null ? {} : { is_big: options.isBig }),
    });
  }

  async downloadAttachment(store: MessageStore, attachment: StoredAttachment): Promise<string> {
    if (attachment.path && fs.existsSync(attachment.path)) {
      return attachment.path;
    }
    if (!attachment.fileId) {
      throw new Error("telegram attachment has no file_id");
    }
    const file = await this.api<TelegramFile>("getFile", { file_id: attachment.fileId });
    if (!file.file_path) {
      throw new Error("telegram getFile response did not include file_path");
    }
    const response = await fetch(`${this.config.apiBaseUrl}/file/bot${this.config.botToken}/${file.file_path}`);
    if (!response.ok) {
      throw new Error(`failed to download telegram file: HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const extension = extensionForTelegramAttachment(attachment, file.file_path);
    const digest = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 24);
    const filename = `${attachment.kind}-${attachment.id ?? "unknown"}-${digest}${extension}`;
    const filePath = store.mediaPath(filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
    if (attachment.id != null) {
      store.updateAttachmentPath(attachment.id, filePath);
    }
    return filePath;
  }

  async downloadUserAvatar(store: MessageStore, userId: string, photoIndex = 0): Promise<{
    path: string;
    mimeType: string;
    size: number;
  }> {
    if (photoIndex === 0) {
      const chat = await this.api<TelegramChat>("getChat", {
        chat_id: telegramId(userId),
      }).catch((err) => {
        warn("telegram getChat for user avatar failed; falling back to profile photos", {
          userId,
          error: String(err),
        });
        return null;
      });
      if (chat?.photo?.big_file_id || chat?.photo?.small_file_id) {
        return this.downloadTelegramFileToMedia(
          store,
          chat.photo.big_file_id || chat.photo.small_file_id,
          `telegram-user-avatar-${safeTelegramMediaId(userId)}`,
          "avatar",
        );
      }
    }

    const photos = await this.api<TelegramUserProfilePhotos>("getUserProfilePhotos", {
      user_id: telegramId(userId),
      offset: photoIndex,
      limit: 1,
    });
    const sizes = photos.photos[0];
    if (!sizes || sizes.length === 0) {
      throw new Error("telegram user has no visible profile photo");
    }

    const photo = [...sizes].sort((a, b) => {
      const aPixels = a.width * a.height;
      const bPixels = b.width * b.height;
      return bPixels - aPixels;
    })[0];
    return this.downloadTelegramFileToMedia(
      store,
      photo.file_id,
      `telegram-user-avatar-${safeTelegramMediaId(userId)}`,
      "avatar",
    );
  }

  private async downloadTelegramFileToMedia(
    store: MessageStore,
    fileId: string,
    filenameBase: string,
    kind: string,
  ): Promise<{ path: string; mimeType: string; size: number }> {
    const file = await this.api<TelegramFile>("getFile", { file_id: fileId });
    if (!file.file_path) {
      throw new Error("telegram getFile response did not include file_path");
    }
    const response = await fetch(`${this.config.apiBaseUrl}/file/bot${this.config.botToken}/${file.file_path}`);
    if (!response.ok) {
      throw new Error(`failed to download telegram ${kind}: HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const extension = path.extname(file.file_path) || ".jpg";
    const filePath = writeMediaFile(store, `${filenameBase}${extension}`, buffer);
    return {
      path: filePath,
      mimeType: mimeTypeForExtension(extension),
      size: buffer.byteLength,
    };
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.pollApi<TelegramUpdate[]>("getUpdates", {
          offset: this.updateOffset || undefined,
          timeout: this.config.pollTimeoutSeconds,
          allowed_updates: ["message", "channel_post"],
        });
        for (const update of updates) {
          this.updateOffset = update.update_id + 1;
          const message = update.message ?? update.channel_post;
          if (!message) {
            continue;
          }
          log("telegram message update received", {
            updateId: update.update_id,
            chatId: message.chat.id,
            chatType: message.chat.type,
            messageId: message.message_id,
            userId: message.from?.id,
          });
          this.emit("message", message, update);
        }
      } catch (err) {
        warn("telegram polling failed", { error: String(err) });
        await sleep(this.config.pollIntervalMs);
      }
    }
  }

  private async pollApi<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return telegramJsonRequest<T>({
      apiBaseUrl: this.config.apiBaseUrl,
      botToken: this.config.botToken,
      method,
      params,
      agent: this.pollAgent,
      timeoutMs: (this.config.pollTimeoutSeconds + 10) * 1000,
    });
  }

  private async api<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const startedAt = Date.now();
    const response = await fetch(`${this.config.apiBaseUrl}/bot${this.config.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const result = await parseTelegramResponse<T>(method, response);
    logSlowTelegramApi(method, startedAt);
    return result;
  }

  private async apiMultipart<T>(method: string, body: FormData): Promise<T> {
    const startedAt = Date.now();
    const response = await fetch(`${this.config.apiBaseUrl}/bot${this.config.botToken}/${method}`, {
      method: "POST",
      body,
    });
    const result = await parseTelegramResponse<T>(method, response);
    logSlowTelegramApi(method, startedAt);
    return result;
  }
}

export function telegramSourceType(message: TelegramMessage): SourceType {
  return message.chat.type === "private" ? "private" : "group";
}

export function telegramTargetId(message: TelegramMessage): string {
  return String(message.chat.id);
}

export function telegramText(message: TelegramMessage): string {
  return (message.text ?? message.caption ?? "").trim();
}

export function telegramDisplayName(user: TelegramUser | undefined): string | null {
  if (!user) {
    return null;
  }
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return name || user.username || String(user.id);
}

export function buildTelegramStoredMessage(
  message: TelegramMessage,
  trigger: TriggerKind,
  botUserId: string,
): StoredMessage {
  const sourceType = telegramSourceType(message);
  const sender = message.from;
  const senderChat = message.sender_chat;
  const userId = sender?.id ?? senderChat?.id ?? message.chat.id;
  const rawText = telegramRawMessage(message);
  return {
    platform: "telegram",
    platformMessageId: String(message.message_id),
    sourceType,
    targetId: telegramTargetId(message),
    groupId: sourceType === "group" ? telegramTargetId(message) : null,
    groupName: telegramChatName(message.chat),
    userId: String(userId),
    nickname: telegramDisplayName(sender) ?? telegramChatName(senderChat) ?? null,
    groupCard: sender?.username ?? senderChat?.username ?? null,
    role: String(userId) === botUserId ? "bot" : null,
    time: message.date,
    text: telegramText(message),
    rawMessage: rawText,
    trigger,
    replyToMessageId: message.reply_to_message?.message_id == null
      ? null
      : String(message.reply_to_message.message_id),
    rawEvent: message,
    attachments: telegramAttachments(message),
  };
}

export function buildTelegramOutboundMessage(options: {
  chatId: string;
  chatTitle: string | null;
  botUserId: string;
  botUsername: string;
  message: TelegramMessage;
  segments: MessageSegment[];
  action: string;
  response: unknown;
  replyToMessageId?: string | null;
}): StoredMessage {
  const sourceType: SourceType = options.message.chat.type === "private" ? "private" : "group";
  return {
    platform: "telegram",
    platformMessageId: String(options.message.message_id),
    sourceType,
    targetId: options.chatId,
    groupId: sourceType === "group" ? options.chatId : null,
    groupName: options.chatTitle,
    userId: options.botUserId,
    nickname: options.botUsername ? `@${options.botUsername}` : "Telegram Bot",
    groupCard: options.botUsername || null,
    role: "bot",
    time: options.message.date ?? Math.floor(Date.now() / 1000),
    text: options.segments.filter((segment) => segment.type === "text").map((segment) => String(segment.data?.text ?? "")).join("").trim(),
    rawMessage: telegramHistoryText(options.segments),
    trigger: "bot_message",
    replyToMessageId: options.replyToMessageId ?? null,
    rawEvent: {
      ...options.message,
      bridge_outbound: true,
      action: options.action,
      response: options.response,
    },
    attachments: telegramAttachments(options.message),
  };
}

export function isTelegramAtBot(message: TelegramMessage, botUsername: string, botUserId: string): boolean {
  const username = botUsername.replace(/^@/, "").toLowerCase();
  const text = message.text ?? message.caption ?? "";
  if (username && text.toLowerCase().includes(`@${username}`)) {
    return true;
  }
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  return entities.some((entity) => {
    if (entity.type === "mention" && username) {
      return text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${username}`;
    }
    if (entity.type === "text_mention" && entity.user) {
      return String(entity.user.id) === botUserId;
    }
    return false;
  });
}

export function isTelegramReplyToBot(message: TelegramMessage, botUserId: string): boolean {
  const replySender = message.reply_to_message?.from;
  return replySender != null && String(replySender.id) === botUserId;
}

export function isTelegramChatIdCommand(message: TelegramMessage, botUsername: string): boolean {
  const text = telegramText(message);
  if (!text.startsWith("/chatid")) {
    return false;
  }
  const [command] = text.split(/\s+/, 1);
  return command === "/chatid" || command.toLowerCase() === `/chatid@${botUsername.toLowerCase()}`;
}

export function telegramChatIdResponse(message: TelegramMessage): string {
  const lines = [
    `chat_id: ${message.chat.id}`,
    `chat_type: ${message.chat.type}`,
  ];
  const title = telegramChatName(message.chat);
  if (title) {
    lines.push(`chat_title: ${title}`);
  }
  if (message.message_thread_id != null) {
    lines.push(`message_thread_id: ${message.message_thread_id}`);
  }
  if (message.from?.id != null) {
    lines.push(`user_id: ${message.from.id}`);
  }
  if (message.from?.username) {
    lines.push(`username: @${message.from.username}`);
  }
  return lines.join("\n");
}

function telegramAttachments(message: TelegramMessage): StoredAttachment[] {
  const attachments: StoredAttachment[] = [];
  if (message.photo && message.photo.length > 0) {
    const photo = [...message.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];
    attachments.push({
      kind: "image",
      fileId: photo.file_id,
      name: `telegram-photo-${message.message_id}.jpg`,
      url: null,
      path: null,
      mimeType: "image/jpeg",
      size: photo.file_size ?? null,
      raw: photo,
    });
  }
  appendTelegramDocumentAttachment(attachments, "file", message.document);
  appendTelegramDocumentAttachment(attachments, "animation", message.animation);
  appendTelegramDocumentAttachment(attachments, "audio", message.audio);
  appendTelegramDocumentAttachment(attachments, "video", message.video);
  appendTelegramDocumentAttachment(attachments, "voice", message.voice);
  appendTelegramDocumentAttachment(attachments, "video_note", message.video_note);
  appendTelegramDocumentAttachment(attachments, "sticker", message.sticker);
  return attachments;
}

function appendTelegramDocumentAttachment(
  attachments: StoredAttachment[],
  kind: string,
  document: TelegramDocument | undefined,
): void {
  if (!document) {
    return;
  }
  attachments.push({
    kind,
    fileId: document.file_id,
    name: document.file_name ?? null,
    url: null,
    path: null,
    mimeType: document.mime_type ?? null,
    size: document.file_size ?? null,
    raw: document,
  });
}

function telegramRawMessage(message: TelegramMessage): string {
  const text = telegramText(message);
  if (text) {
    return text;
  }
  const attachments = telegramAttachments(message);
  if (attachments.length === 0) {
    return "[non-text message]";
  }
  return attachments.map((attachment) => `[${attachment.kind}:${attachment.name ?? attachment.fileId ?? "unnamed"}]`).join(" ");
}

function telegramHistoryText(segments: MessageSegment[]): string {
  return segments.map((segment) => {
    const data = segment.data ?? {};
    switch (segment.type) {
      case "text":
        return String(data.text ?? "");
      case "mention":
        return String(data.username ? `@${data.username}` : data.text ?? data.user_id ?? "");
      case "file":
        return `[file:${String(data.file ?? data.name ?? "")}]`;
      default:
        return `[${segment.type}]`;
    }
  }).join("");
}

function telegramChatName(chat: TelegramChat | undefined): string | null {
  if (!chat) {
    return null;
  }
  const name = chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(" ").trim() ?? chat.username;
  return name || chat.username || null;
}

async function parseTelegramResponse<T>(method: string, response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as TelegramApiResponse<T> | null;
  if (!response.ok || !payload?.ok) {
    const description = payload?.description ?? `HTTP ${response.status}`;
    throw new Error(`Telegram ${method} failed: ${description}`);
  }
  return payload.result as T;
}

function createTelegramAgent(apiBaseUrl: string, maxSockets: number): TelegramAgent {
  const url = new URL(apiBaseUrl);
  const options = { keepAlive: true, maxSockets };
  return url.protocol === "http:" ? new http.Agent(options) : new https.Agent(options);
}

async function telegramJsonRequest<T>(options: {
  apiBaseUrl: string;
  botToken: string;
  method: string;
  params: Record<string, unknown>;
  agent: TelegramAgent;
  timeoutMs: number;
}): Promise<T> {
  const url = new URL(`${options.apiBaseUrl}/bot${options.botToken}/${options.method}`);
  const body = JSON.stringify(options.params);
  const transport = url.protocol === "http:" ? http : https;

  return new Promise<T>((resolve, reject) => {
    const request = transport.request(url, {
      method: "POST",
      agent: options.agent,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const payload = parseTelegramPayload<T>(text);
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300 || !payload?.ok) {
          const description = payload?.description ?? `HTTP ${response.statusCode ?? "unknown"}`;
          reject(new Error(`Telegram ${options.method} failed: ${description}`));
          return;
        }
        resolve(payload.result as T);
      });
    });

    request.on("error", reject);
    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error(`Telegram ${options.method} timed out after ${options.timeoutMs}ms`));
    });
    request.end(body);
  });
}

function parseTelegramPayload<T>(text: string): TelegramApiResponse<T> | null {
  try {
    return JSON.parse(text) as TelegramApiResponse<T>;
  } catch {
    return null;
  }
}

function logSlowTelegramApi(method: string, startedAt: number): void {
  const durationMs = Date.now() - startedAt;
  if (durationMs >= 3000) {
    warn("telegram api request slow", { method, durationMs });
  }
}

function telegramId(value: string): string | number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (Number.isSafeInteger(parsed) && String(parsed) === trimmed) {
    return parsed;
  }
  return trimmed;
}

function isLocalFile(value: string): boolean {
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return false;
  }
  return path.isAbsolute(value) || fs.existsSync(value);
}

function extensionForTelegramAttachment(attachment: StoredAttachment, filePath: string): string {
  const nameExt = attachment.name ? path.extname(attachment.name) : "";
  if (nameExt) {
    return nameExt;
  }
  const pathExt = path.extname(filePath);
  if (pathExt) {
    return pathExt;
  }
  if (attachment.mimeType === "image/jpeg") {
    return ".jpg";
  }
  if (attachment.mimeType === "image/png") {
    return ".png";
  }
  return "";
}

function mimeTypeForExtension(extension: string): string {
  switch (extension.toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
    default:
      return "image/jpeg";
  }
}

function safeTelegramMediaId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
