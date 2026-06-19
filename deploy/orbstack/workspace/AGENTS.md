# Astral QQ Bridge Workspace

当你收到来自 QQ 的消息时，通常必须使用 `qq` MCP 工具回复到消息来源所在的同一个 QQ 渠道。

不要只直接输出文本作为回复。直接输出的文本不会发送到 QQ，发消息的人看不到。面向 QQ 用户的答复必须调用发送工具。

- 私聊消息：使用 `qq_send_private_message` 回复给 `sender_user_id`。
- 群消息：使用 `qq_send_group_message` 回复到 `group_id`，并在内容里明确回应触发消息的发送者。
- 群里需要 @ 人时，不要把 `@QQ号` 写进普通文本。使用 `qq_send_group_message` 的 `parts` 参数按顺序混排文本和 at：`[{ type: "text", text: "请 " }, { type: "at", user_id: "TARGET_QQ" }, { type: "text", text: " 看一下" }]`。
- 如果要在一条消息里 @ 多个人，继续在 `parts` 里插入多个 `{ type: "at", user_id: "..." }`，并用 `{ type: "text", text: "..." }` 放置逗号、空格和其他文字。
- 如果要回复指定历史消息，先用 `qq_get_recent_messages`、`qq_get_message` 或 `qq_search_messages` 找到那条消息的 `message_id`，然后调用 `qq_send_group_message` 或 `qq_send_private_message` 时传 `reply_to_message_id`。
- 每条 QQ 输入可能包含 `conversation_unread`。其中 `unread_count` 表示这个群/私聊自上一次推给 Astral 以来累计的已存消息数，包含当前消息。`qq_get_unread_messages` 可以拉取当前会话这批未读消息，默认最多返回最近 100 条；是否调用要根据语境判断，不要机械地每次都拉。
- 发送图片：先把图片生成或保存到 `/workspace/...`，或者使用 `qq_download_media` 得到的 `/app/media/...` 路径，然后调用 `qq_send_group_message` 或 `qq_send_private_message`，传 `images: ["/workspace/example.png"]`。可以同时传 `message` 作为配文。不要只输出图片路径、Markdown 图片语法或本地链接，QQ 用户看不到。
- 图片也可以放进 `parts` 精确控制顺序，例如 `[{ type: "text", text: "图：" }, { type: "image", file: "/workspace/result.png" }, { type: "text", text: " " }, { type: "at", user_id: "TARGET_QQ" }]`。
- 发送非图片文件：先把文件生成或保存到 `/workspace/...`，或者使用 `/app/media/...` 路径，然后调用 `qq_send_group_file` 或 `qq_send_private_file`，传 `file: "/workspace/example.zip"`；需要友好文件名时同时传 `name`。
- 需要发送本地图片或文件时，优先把文件放在 `/workspace`；通过 `qq_download_media` 下载的历史媒体会在 `/app/media/...`，这些路径也可以直接用于发送工具。
- 群图片示例：`qq_send_group_message({ group_id, message: "", images: ["/workspace/result.png"] })`。
- 群内混排 @ 示例：`qq_send_group_message({ group_id, parts: [{ type: "text", text: "收到 " }, { type: "at", user_id: sender_user_id }, { type: "text", text: "，这个我让 " }, { type: "at", user_id: "OTHER_QQ" }, { type: "text", text: " 一起看" }] })`。
- 回复历史消息示例：`qq_send_group_message({ group_id, reply_to_message_id: "MESSAGE_ID", parts: [{ type: "at", user_id: sender_user_id }, { type: "text", text: " 这条我回复在原消息下面" }] })`。
- 私聊图片示例：`qq_send_private_message({ user_id: sender_user_id, message: "图在这里", images: ["/workspace/result.png"] })`。
- 群文件示例：`qq_send_group_file({ group_id, file: "/workspace/result.zip", name: "result.zip" })`。
- 私聊文件示例：`qq_send_private_file({ user_id: sender_user_id, file: "/workspace/result.txt", name: "result.txt" })`。
- 如果需要上下文，再用 `qq_get_unread_messages`、`qq_get_recent_messages`、`qq_get_message`、`qq_search_messages` 或 `qq_download_media` 拉取历史和附件；如果当前消息已经足够清楚，就直接回复。
- 只有在用户明确要求不要回复、消息明显不需要回复、或工具/权限不可用时，才可以不发送 QQ 回复；这种例外要在内部判断清楚，不要默认沉默。
- 不要把面向用户的回复只写在普通文本输出里；那不会到达 QQ。必须通过 QQ MCP send 工具发回 QQ。
