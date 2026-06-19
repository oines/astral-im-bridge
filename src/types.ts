export type SourceType = "group" | "private";
export type TriggerKind = "group_mention" | "group_reply" | "private_message" | "none";

export interface BridgeConfig {
  onebot: OneBotConfig;
  mcp: McpConfig;
  astral: AstralConfig;
  qq: QqConfig;
  storage: StorageConfig;
}

export interface OneBotConfig {
  host: string;
  port: number;
  path: string;
  accessToken: string | null;
  actionTimeoutMs: number;
}

export interface McpConfig {
  transport: "stdio" | "http";
  host: string;
  port: number;
  path: string;
}

export interface AstralConfig {
  appServerUrl: string;
  authToken: string | null;
  threadId: string;
  cwd: string | null;
  model: string | null;
  includeImageInputs: boolean;
}

export interface QqConfig {
  botUserId: string;
  allowedGroupIds: string[];
  allowedPrivateUserIds: string[];
  recordUntriggered: boolean;
}

export interface StorageConfig {
  dbPath: string;
  mediaDir: string;
  downloadMedia: boolean;
}

export interface MessageSegment {
  type: string;
  data?: Record<string, unknown>;
}

export interface OneBotSender {
  user_id?: number | string;
  nickname?: string;
  card?: string;
  role?: string;
  title?: string;
  [key: string]: unknown;
}

export interface OneBotMessageEvent {
  post_type: "message" | "message_sent";
  message_type: SourceType;
  sub_type?: string;
  message_id: number | string;
  user_id: number | string;
  group_id?: number | string;
  self_id?: number | string;
  time?: number;
  message: MessageSegment[] | string;
  raw_message?: string;
  sender?: OneBotSender;
  [key: string]: unknown;
}

export interface GroupInfo {
  group_id: string;
  group_name: string | null;
  member_count?: number | null;
  max_member_count?: number | null;
}

export interface StoredAttachment {
  id?: number;
  kind: string;
  fileId: string | null;
  name: string | null;
  url: string | null;
  path: string | null;
  mimeType: string | null;
  size: number | null;
  raw: unknown;
}

export interface StoredMessage {
  id?: number;
  platformMessageId: string;
  sourceType: SourceType;
  targetId: string;
  groupId: string | null;
  groupName: string | null;
  userId: string;
  nickname: string | null;
  groupCard: string | null;
  role: string | null;
  time: number;
  text: string;
  rawMessage: string;
  trigger: TriggerKind;
  replyToMessageId: string | null;
  rawEvent: unknown;
  attachments: StoredAttachment[];
  conversationUnread?: ConversationUnread;
}

export interface ConversationUnread {
  unreadCount: number;
}

export interface StoredMessageRow {
  id: number;
  platform_message_id: string;
  source_type: SourceType;
  target_id: string;
  group_id: string | null;
  group_name: string | null;
  user_id: string;
  nickname: string | null;
  group_card: string | null;
  role: string | null;
  time: number;
  text: string;
  raw_message: string;
  trigger: TriggerKind;
  reply_to_message_id: string | null;
  raw_event_json: string;
}
