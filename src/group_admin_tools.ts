import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OneBotClient } from "./onebot.js";
import type { BridgeConfig } from "./types.js";

const memberActionSchema = z.enum([
  "kick",
  "ban",
  "unban",
  "set_admin",
  "unset_admin",
  "set_card",
  "set_special_title",
  "get_muted_members",
]);

const requestActionSchema = z.enum([
  "get_system_messages",
  "get_ignored_join_requests",
  "approve_join_request",
  "reject_join_request",
]);

const settingsActionSchema = z.enum([
  "set_name",
  "set_avatar",
  "set_whole_ban",
  "leave_group",
]);

const messageActionSchema = z.enum([
  "recall_message",
  "set_essence",
  "delete_essence",
  "get_essence_messages",
  "get_at_all_remain",
  "mark_as_read",
]);

const noticeActionSchema = z.enum([
  "send_notice",
  "get_notices",
  "delete_notice",
]);

const fileActionSchema = z.enum([
  "upload_file",
  "delete_file",
  "create_folder",
  "delete_folder",
  "get_file_system_info",
  "get_root_files",
  "get_files_by_folder",
  "get_file_url",
]);

const infoActionSchema = z.enum([
  "get_group_list",
  "get_group_info",
  "get_group_info_ex",
  "get_member_info",
  "get_member_list",
  "get_honor_info",
]);

export function registerGroupAdminTools(
  server: McpServer,
  config: BridgeConfig,
  onebot: OneBotClient,
): void {
  server.tool(
    "qq_group_admin_help",
    "List QQ group administration actions exposed by this bridge. Disbanding groups is intentionally not implemented.",
    {
      topic: z.enum(["all", "member", "request", "settings", "message", "notice", "file", "info"])
        .default("all"),
    },
    async (args) => structured(groupAdminHelp(args.topic)),
  );

  server.tool(
    "qq_group_member_admin",
    "Run member-level QQ group admin actions. Mutation actions require confirm:true and should only be used after the user explicitly asks.",
    {
      action: memberActionSchema,
      group_id: z.string(),
      user_id: z.string().optional(),
      duration_seconds: z.number().int().min(0).max(30 * 24 * 60 * 60).optional(),
      card: z.string().max(120).optional(),
      special_title: z.string().max(120).optional(),
      reject_add_request: z.boolean().default(false),
      confirm: z.boolean().default(false),
      reason: z.string().max(500).optional(),
    },
    async (args) => {
      assertAllowedGroup(config, args.group_id);
      const response = await runMemberAction(onebot, args);
      return structured(groupAdminResponse(args.action, args, response));
    },
  );

  server.tool(
    "qq_group_request_admin",
    "Get or handle QQ group join/invite requests. Approve/reject actions require confirm:true.",
    {
      action: requestActionSchema,
      group_id: z.string().optional(),
      flag: z.string().optional(),
      sub_type: z.string().default("add"),
      reason: z.string().max(500).default(""),
      confirm: z.boolean().default(false),
    },
    async (args) => {
      if (args.group_id) {
        assertAllowedGroup(config, args.group_id);
      }
      const response = await runRequestAction(onebot, args);
      return structured(groupAdminResponse(args.action, args, response));
    },
  );

  server.tool(
    "qq_group_settings_admin",
    "Run QQ group setting actions. Group disbanding is not exposed; leave_group only makes the bot leave the group. Mutation actions require confirm:true.",
    {
      action: settingsActionSchema,
      group_id: z.string(),
      group_name: z.string().max(120).optional(),
      file: z.string().optional(),
      enable: z.boolean().optional(),
      confirm: z.boolean().default(false),
      reason: z.string().max(500).optional(),
    },
    async (args) => {
      assertAllowedGroup(config, args.group_id);
      const response = await runSettingsAction(onebot, args);
      return structured(groupAdminResponse(args.action, args, response));
    },
  );

  server.tool(
    "qq_group_message_admin",
    "Run QQ group message administration actions such as recall, essence message changes, @all quota lookup, and mark-as-read. Mutation actions require confirm:true.",
    {
      action: messageActionSchema,
      group_id: z.string(),
      message_id: z.string().optional(),
      confirm: z.boolean().default(false),
      reason: z.string().max(500).optional(),
    },
    async (args) => {
      assertAllowedGroup(config, args.group_id);
      const response = await runMessageAction(onebot, args);
      return structured(groupAdminResponse(args.action, args, response));
    },
  );

  server.tool(
    "qq_group_notice_admin",
    "Run QQ group notice actions. NapCat notice APIs are extension actions; use extra_params for adapter-specific fields when needed. Mutation actions require confirm:true.",
    {
      action: noticeActionSchema,
      group_id: z.string(),
      content: z.string().max(5000).optional(),
      notice_id: z.string().optional(),
      extra_params: z.record(z.string(), z.unknown()).default({}),
      confirm: z.boolean().default(false),
      reason: z.string().max(500).optional(),
    },
    async (args) => {
      assertAllowedGroup(config, args.group_id);
      const response = await runNoticeAction(onebot, args);
      return structured(groupAdminResponse(args.action, args, response));
    },
  );

  server.tool(
    "qq_group_file_admin",
    "Run QQ group file administration actions: upload, delete, folder management, list, and URL lookup. Delete/create/upload mutations require confirm:true.",
    {
      action: fileActionSchema,
      group_id: z.string(),
      file: z.string().optional(),
      name: z.string().optional(),
      folder: z.string().optional(),
      folder_id: z.string().optional(),
      parent_id: z.string().optional(),
      file_id: z.string().optional(),
      busid: z.union([z.number().int(), z.string()]).optional(),
      confirm: z.boolean().default(false),
      reason: z.string().max(500).optional(),
    },
    async (args) => {
      assertAllowedGroup(config, args.group_id);
      const response = await runFileAction(onebot, args);
      return structured(groupAdminResponse(args.action, args, response));
    },
  );

  server.tool(
    "qq_group_info_admin",
    "Read QQ group and member information for administration decisions.",
    {
      action: infoActionSchema,
      group_id: z.string().optional(),
      user_id: z.string().optional(),
      no_cache: z.boolean().default(false),
      honor_type: z.enum(["talkative", "performer", "legend", "strong_newbie", "emotion", "all"])
        .default("all"),
    },
    async (args) => {
      if (args.group_id) {
        assertAllowedGroup(config, args.group_id);
      }
      const response = await runInfoAction(onebot, args);
      return structured(groupAdminResponse(args.action, args, response));
    },
  );
}

function groupAdminHelp(topic: string): Record<string, unknown> {
  const sections = {
    member: {
      tool: "qq_group_member_admin",
      actions: {
        kick: "Kick a member. Requires group_id, user_id, confirm:true. Optional reject_add_request.",
        ban: "Mute a member. Requires group_id, user_id, duration_seconds, confirm:true.",
        unban: "Unmute a member. Requires group_id, user_id, confirm:true.",
        set_admin: "Grant admin. Requires group_id, user_id, confirm:true.",
        unset_admin: "Revoke admin. Requires group_id, user_id, confirm:true.",
        set_card: "Set member card. Requires group_id, user_id, card, confirm:true.",
        set_special_title: "Set member special title. Requires group_id, user_id, special_title, confirm:true.",
        get_muted_members: "List muted members. Requires group_id.",
      },
    },
    request: {
      tool: "qq_group_request_admin",
      actions: {
        get_system_messages: "Get group system messages containing join/invite request flags.",
        get_ignored_join_requests: "Get ignored group join notifications. Requires group_id.",
        approve_join_request: "Approve a join/invite request. Requires flag, confirm:true. Optional sub_type.",
        reject_join_request: "Reject a join/invite request. Requires flag, confirm:true. Optional reason/sub_type.",
      },
    },
    settings: {
      tool: "qq_group_settings_admin",
      actions: {
        set_name: "Set group name. Requires group_id, group_name, confirm:true.",
        set_avatar: "Set group avatar. Requires group_id, file, confirm:true.",
        set_whole_ban: "Enable/disable whole-group mute. Requires group_id, enable, confirm:true.",
        leave_group: "Make the bot leave the group. Requires group_id, confirm:true. Disband is not implemented.",
      },
    },
    message: {
      tool: "qq_group_message_admin",
      actions: {
        recall_message: "Recall/delete a message. Requires group_id, message_id, confirm:true.",
        set_essence: "Set a message as essence. Requires group_id, message_id, confirm:true.",
        delete_essence: "Remove essence status. Requires group_id, message_id, confirm:true.",
        get_essence_messages: "List essence messages. Requires group_id.",
        get_at_all_remain: "Get remaining @all quota. Requires group_id.",
        mark_as_read: "Mark group messages as read. Requires group_id.",
      },
    },
    notice: {
      tool: "qq_group_notice_admin",
      actions: {
        send_notice: "Send group notice. Requires group_id, content, confirm:true.",
        get_notices: "Get group notices. Requires group_id.",
        delete_notice: "Delete group notice. Requires group_id, notice_id, confirm:true.",
      },
    },
    file: {
      tool: "qq_group_file_admin",
      actions: {
        upload_file: "Upload group file. Requires group_id, file, name, confirm:true. Optional folder.",
        delete_file: "Delete group file. Requires group_id, file_id, busid, confirm:true.",
        create_folder: "Create group file folder. Requires group_id, name, confirm:true. Optional parent_id.",
        delete_folder: "Delete group folder. Requires group_id, folder_id, confirm:true.",
        get_file_system_info: "Get group file quota info. Requires group_id.",
        get_root_files: "List root group files. Requires group_id.",
        get_files_by_folder: "List folder files. Requires group_id, folder_id.",
        get_file_url: "Get group file download URL. Requires group_id, file_id, busid.",
      },
    },
    info: {
      tool: "qq_group_info_admin",
      actions: {
        get_group_list: "List groups.",
        get_group_info: "Get group info. Requires group_id.",
        get_group_info_ex: "Get extended group info. Requires group_id.",
        get_member_info: "Get member info. Requires group_id, user_id.",
        get_member_list: "List group members. Requires group_id.",
        get_honor_info: "Get group honor info. Requires group_id. Optional honor_type.",
      },
    },
  };

  if (topic !== "all" && topic in sections) {
    return { topic, ...sections[topic as keyof typeof sections], noDisband: true };
  }
  return { noDisband: true, sections };
}

async function runMemberAction(
  onebot: OneBotClient,
  args: z.infer<typeof memberActionSchema> extends never ? never : {
    action: z.infer<typeof memberActionSchema>;
    group_id: string;
    user_id?: string;
    duration_seconds?: number;
    card?: string;
    special_title?: string;
    reject_add_request: boolean;
    confirm: boolean;
  },
): Promise<unknown> {
  switch (args.action) {
    case "kick":
      requireConfirm(args.confirm, args.action);
      return callGroupAction(onebot, "set_group_kick", {
        group_id: oneBotId(args.group_id),
        user_id: requiredId(args.user_id, "user_id"),
        reject_add_request: args.reject_add_request,
      });
    case "ban":
      requireConfirm(args.confirm, args.action);
      return callGroupAction(onebot, "set_group_ban", {
        group_id: oneBotId(args.group_id),
        user_id: requiredId(args.user_id, "user_id"),
        duration: args.duration_seconds ?? 600,
      });
    case "unban":
      requireConfirm(args.confirm, args.action);
      return callGroupAction(onebot, "set_group_ban", {
        group_id: oneBotId(args.group_id),
        user_id: requiredId(args.user_id, "user_id"),
        duration: 0,
      });
    case "set_admin":
      requireConfirm(args.confirm, args.action);
      return callGroupAction(onebot, "set_group_admin", {
        group_id: oneBotId(args.group_id),
        user_id: requiredId(args.user_id, "user_id"),
        enable: true,
      });
    case "unset_admin":
      requireConfirm(args.confirm, args.action);
      return callGroupAction(onebot, "set_group_admin", {
        group_id: oneBotId(args.group_id),
        user_id: requiredId(args.user_id, "user_id"),
        enable: false,
      });
    case "set_card":
      requireConfirm(args.confirm, args.action);
      return callGroupAction(onebot, "set_group_card", {
        group_id: oneBotId(args.group_id),
        user_id: requiredId(args.user_id, "user_id"),
        card: requiredText(args.card, "card"),
      });
    case "set_special_title":
      requireConfirm(args.confirm, args.action);
      return callGroupAction(onebot, "set_group_special_title", {
        group_id: oneBotId(args.group_id),
        user_id: requiredId(args.user_id, "user_id"),
        special_title: requiredText(args.special_title, "special_title"),
      });
    case "get_muted_members":
      return callGroupAction(onebot, "get_group_shut_list", {
        group_id: oneBotId(args.group_id),
      });
  }
}

async function runRequestAction(
  onebot: OneBotClient,
  args: {
    action: z.infer<typeof requestActionSchema>;
    group_id?: string;
    flag?: string;
    sub_type: string;
    reason: string;
    confirm: boolean;
  },
): Promise<unknown> {
  switch (args.action) {
    case "get_system_messages":
      return callGroupAction(onebot, "get_group_system_msg", {});
    case "get_ignored_join_requests":
      return callGroupAction(onebot, "get_group_ignore_add_request", {
        group_id: oneBotId(requiredText(args.group_id, "group_id")),
      });
    case "approve_join_request":
      requireConfirm(args.confirm, args.action);
      return callGroupAction(onebot, "set_group_add_request", {
        flag: requiredText(args.flag, "flag"),
        sub_type: args.sub_type,
        approve: true,
        reason: args.reason,
      });
    case "reject_join_request":
      requireConfirm(args.confirm, args.action);
      return callGroupAction(onebot, "set_group_add_request", {
        flag: requiredText(args.flag, "flag"),
        sub_type: args.sub_type,
        approve: false,
        reason: args.reason,
      });
  }
}

async function runSettingsAction(
  onebot: OneBotClient,
  args: {
    action: z.infer<typeof settingsActionSchema>;
    group_id: string;
    group_name?: string;
    file?: string;
    enable?: boolean;
    confirm: boolean;
  },
): Promise<unknown> {
  requireConfirm(args.confirm, args.action);
  switch (args.action) {
    case "set_name":
      return callGroupAction(onebot, "set_group_name", {
        group_id: oneBotId(args.group_id),
        group_name: requiredText(args.group_name, "group_name"),
      });
    case "set_avatar":
      return callGroupAction(onebot, "set_group_portrait", {
        group_id: oneBotId(args.group_id),
        file: requiredText(args.file, "file"),
      });
    case "set_whole_ban":
      return callGroupAction(onebot, "set_group_whole_ban", {
        group_id: oneBotId(args.group_id),
        enable: requiredBoolean(args.enable, "enable"),
      });
    case "leave_group":
      return callGroupAction(onebot, "set_group_leave", {
        group_id: oneBotId(args.group_id),
        is_dismiss: false,
      });
  }
}

async function runMessageAction(
  onebot: OneBotClient,
  args: {
    action: z.infer<typeof messageActionSchema>;
    group_id: string;
    message_id?: string;
    confirm: boolean;
  },
): Promise<unknown> {
  switch (args.action) {
    case "recall_message":
      requireConfirm(args.confirm, args.action);
      return callGroupAction(onebot, "delete_msg", {
        message_id: oneBotId(requiredText(args.message_id, "message_id")),
      });
    case "set_essence":
      requireConfirm(args.confirm, args.action);
      return callGroupAction(onebot, "set_essence_msg", {
        message_id: oneBotId(requiredText(args.message_id, "message_id")),
      });
    case "delete_essence":
      requireConfirm(args.confirm, args.action);
      return callGroupAction(onebot, "delete_essence_msg", {
        message_id: oneBotId(requiredText(args.message_id, "message_id")),
      });
    case "get_essence_messages":
      return callGroupAction(onebot, "get_essence_msg_list", {
        group_id: oneBotId(args.group_id),
      });
    case "get_at_all_remain":
      return callGroupAction(onebot, "get_group_at_all_remain", {
        group_id: oneBotId(args.group_id),
      });
    case "mark_as_read":
      return callGroupAction(onebot, "mark_group_msg_as_read", {
        group_id: oneBotId(args.group_id),
      });
  }
}

async function runNoticeAction(
  onebot: OneBotClient,
  args: {
    action: z.infer<typeof noticeActionSchema>;
    group_id: string;
    content?: string;
    notice_id?: string;
    extra_params: Record<string, unknown>;
    confirm: boolean;
  },
): Promise<unknown> {
  switch (args.action) {
    case "send_notice":
      requireConfirm(args.confirm, args.action);
      return callGroupAction(onebot, "_send_group_notice", {
        group_id: oneBotId(args.group_id),
        content: requiredText(args.content, "content"),
        ...args.extra_params,
      });
    case "get_notices":
      return callGroupAction(onebot, "_get_group_notice", {
        group_id: oneBotId(args.group_id),
        ...args.extra_params,
      });
    case "delete_notice":
      requireConfirm(args.confirm, args.action);
      return callGroupAction(onebot, "_del_group_notice", {
        group_id: oneBotId(args.group_id),
        notice_id: requiredText(args.notice_id, "notice_id"),
        fid: args.notice_id,
        ...args.extra_params,
      });
  }
}

async function runFileAction(
  onebot: OneBotClient,
  args: {
    action: z.infer<typeof fileActionSchema>;
    group_id: string;
    file?: string;
    name?: string;
    folder?: string;
    folder_id?: string;
    parent_id?: string;
    file_id?: string;
    busid?: number | string;
    confirm: boolean;
  },
): Promise<unknown> {
  switch (args.action) {
    case "upload_file":
      requireConfirm(args.confirm, args.action);
      return callGroupAction(onebot, "upload_group_file", {
        group_id: oneBotId(args.group_id),
        file: requiredText(args.file, "file"),
        name: requiredText(args.name, "name"),
        ...(args.folder ? { folder: args.folder } : {}),
      });
    case "delete_file":
      requireConfirm(args.confirm, args.action);
      return callGroupAction(onebot, "delete_group_file", {
        group_id: oneBotId(args.group_id),
        file_id: requiredText(args.file_id, "file_id"),
        busid: requiredValue(args.busid, "busid"),
      });
    case "create_folder":
      requireConfirm(args.confirm, args.action);
      return callGroupAction(onebot, "create_group_file_folder", {
        group_id: oneBotId(args.group_id),
        name: requiredText(args.name, "name"),
        parent_id: args.parent_id ?? "/",
      });
    case "delete_folder":
      requireConfirm(args.confirm, args.action);
      return callGroupAction(onebot, "delete_group_folder", {
        group_id: oneBotId(args.group_id),
        folder_id: requiredText(args.folder_id, "folder_id"),
      });
    case "get_file_system_info":
      return callGroupAction(onebot, "get_group_file_system_info", {
        group_id: oneBotId(args.group_id),
      });
    case "get_root_files":
      return callGroupAction(onebot, "get_group_root_files", {
        group_id: oneBotId(args.group_id),
      });
    case "get_files_by_folder":
      return callGroupAction(onebot, "get_group_files_by_folder", {
        group_id: oneBotId(args.group_id),
        folder_id: requiredText(args.folder_id, "folder_id"),
      });
    case "get_file_url":
      return callGroupAction(onebot, "get_group_file_url", {
        group_id: oneBotId(args.group_id),
        file_id: requiredText(args.file_id, "file_id"),
        busid: requiredValue(args.busid, "busid"),
      });
  }
}

async function runInfoAction(
  onebot: OneBotClient,
  args: {
    action: z.infer<typeof infoActionSchema>;
    group_id?: string;
    user_id?: string;
    no_cache: boolean;
    honor_type: string;
  },
): Promise<unknown> {
  switch (args.action) {
    case "get_group_list":
      return callGroupAction(onebot, "get_group_list", { no_cache: args.no_cache });
    case "get_group_info":
      return callGroupAction(onebot, "get_group_info", {
        group_id: oneBotId(requiredText(args.group_id, "group_id")),
        no_cache: args.no_cache,
      });
    case "get_group_info_ex":
      return callGroupAction(onebot, "get_group_info_ex", {
        group_id: oneBotId(requiredText(args.group_id, "group_id")),
      });
    case "get_member_info":
      return callGroupAction(onebot, "get_group_member_info", {
        group_id: oneBotId(requiredText(args.group_id, "group_id")),
        user_id: requiredId(args.user_id, "user_id"),
        no_cache: args.no_cache,
      });
    case "get_member_list":
      return callGroupAction(onebot, "get_group_member_list", {
        group_id: oneBotId(requiredText(args.group_id, "group_id")),
        no_cache: args.no_cache,
      });
    case "get_honor_info":
      return callGroupAction(onebot, "get_group_honor_info", {
        group_id: oneBotId(requiredText(args.group_id, "group_id")),
        type: args.honor_type,
      });
  }
}

async function callGroupAction(
  onebot: OneBotClient,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return onebot.callAction(action, params);
}

function assertAllowedGroup(config: BridgeConfig, groupId: string): void {
  const normalizedGroupId = groupId.trim();
  if (!normalizedGroupId) {
    throw new Error("group_id is required");
  }
  if (
    config.qq.allowedGroupIds.length > 0
    && !config.qq.allowedGroupIds.includes(normalizedGroupId)
    && !config.qq.alwaysTriggerGroupIds.includes(normalizedGroupId)
  ) {
    throw new Error(`group_id ${normalizedGroupId} is not in configured allowedGroupIds`);
  }
}

function requireConfirm(confirm: boolean, action: string): void {
  if (!confirm) {
    throw new Error(`action ${action} requires confirm:true`);
  }
}

function requiredText(value: string | undefined, field: string): string {
  if (!value?.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function requiredId(value: string | undefined, field: string): string | number {
  return oneBotId(requiredText(value, field));
}

function requiredBoolean(value: boolean | undefined, field: string): boolean {
  if (value == null) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function requiredValue<T>(value: T | undefined, field: string): T {
  if (value == null || value === "") {
    throw new Error(`${field} is required`);
  }
  return value;
}

function oneBotId(value: string): string | number {
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isSafeInteger(numeric) && String(numeric) === trimmed) {
    return numeric;
  }
  return trimmed;
}

function groupAdminResponse(
  action: string,
  args: {
    group_id?: string;
    user_id?: string;
    message_id?: string;
    file_id?: string;
    folder_id?: string;
    notice_id?: string;
    flag?: string;
  },
  response: unknown,
): Record<string, unknown> {
  const data = oneBotResponseData(response);
  return compactObject({
    ok: oneBotActionOk(response),
    platform: "qq",
    action,
    group_id: args.group_id ?? null,
    user_id: args.user_id ?? null,
    message_id: args.message_id ?? null,
    file_id: args.file_id ?? null,
    folder_id: args.folder_id ?? null,
    notice_id: args.notice_id ?? null,
    flag: args.flag ?? null,
    status: oneBotActionStatus(response),
    retcode: oneBotActionRetcode(response),
    data,
  });
}

function oneBotActionOk(response: unknown): boolean {
  if (!isPlainObject(response)) {
    return true;
  }
  return response.status === "ok" || response.retcode === 0;
}

function oneBotActionStatus(response: unknown): string | null {
  if (!isPlainObject(response)) {
    return null;
  }
  const status = response.status ?? response.message ?? response.wording;
  return status == null ? null : String(status);
}

function oneBotActionRetcode(response: unknown): number | string | null {
  if (!isPlainObject(response)) {
    return null;
  }
  const retcode = response.retcode;
  if (typeof retcode === "number" || typeof retcode === "string") {
    return retcode;
  }
  return null;
}

function oneBotResponseData(response: unknown): unknown {
  if (!isPlainObject(response) || !("data" in response)) {
    return null;
  }
  return response.data ?? null;
}

function compactObject(fields: Record<string, unknown>): Record<string, unknown> {
  const response: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) {
      continue;
    }
    response[key] = value;
  }
  return response;
}

function structured(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: isPlainObject(value) ? value : { result: value },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
