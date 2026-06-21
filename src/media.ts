import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MessageStore } from "./store.js";
import type { StoredAttachment } from "./types.js";

export async function ensureAttachmentDownloaded(
  store: MessageStore,
  attachment: StoredAttachment,
): Promise<string> {
  if (attachment.path && fs.existsSync(attachment.path)) {
    return attachment.path;
  }
  if (!attachment.url) {
    throw new Error("attachment has no downloadable URL");
  }

  return downloadAttachmentFromUrl(store, attachment, attachment.url);
}

export async function downloadAttachmentFromUrl(
  store: MessageStore,
  attachment: StoredAttachment,
  url: string,
  headers?: Record<string, string>,
): Promise<string> {
  if (attachment.path && fs.existsSync(attachment.path)) {
    return attachment.path;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`failed to download media: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = extensionFor(attachment);
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

function extensionFor(attachment: StoredAttachment): string {
  const nameExt = attachment.name ? path.extname(attachment.name) : "";
  if (nameExt) {
    return nameExt;
  }
  if (attachment.mimeType === "image/jpeg") {
    return ".jpg";
  }
  if (attachment.mimeType === "image/png") {
    return ".png";
  }
  if (attachment.kind === "image") {
    return ".jpg";
  }
  return "";
}

export function writeMediaFile(
  store: MessageStore,
  filename: string,
  buffer: Buffer,
): string {
  const filePath = store.mediaPath(filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return filePath;
}
