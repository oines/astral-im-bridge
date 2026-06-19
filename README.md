# Astral Bridge

Astral Bridge connects QQ, through NapCat's OneBot v11 reverse WebSocket, to one fixed
Astral Code app-server session. It also exposes MCP tools so the agent can reply back to
QQ, send files or images, and fetch recent conversation context when needed.

This project is intended for self-hosted personal or team automation. It is not affiliated
with QQ, Tencent, NapCat, OneBot, or Astral Code.

## Features

- Receive QQ private and group messages from NapCat over OneBot v11.
- Route every accepted message into one configured Astral app-server thread.
- Trigger group messages only when the bot is mentioned or replied to.
- Trigger every message from configured private QQ users.
- Store allowed conversation history locally in SQLite for later MCP lookups.
- Include compact inbound context: group name/id, sender QQ, nickname, group card,
  sender role, message id, trigger kind, unread count, and attachment metadata.
- Support app-server `turn/steer` when the fixed Astral thread already has an active turn.
- Expose Streamable HTTP or stdio MCP tools for QQ replies, history, media, files,
  images, mentions, and replies to specific QQ message ids.
- Accept generic external event webhooks and forward them into the fixed Astral session.
- Expose a read-only Web UI for connection status, routing, recent messages,
  recent conversations, and recent bridge logs.
- Add a random 3-5 second delay before outbound QQ send actions.

## Requirements

- Node.js 26 or newer. The bridge uses `node:sqlite`.
- pnpm 10 or newer.
- A running Astral Code app-server.
- NapCat configured with OneBot v11 reverse WebSocket.

## Quick Start

```bash
pnpm install
cp examples/config.example.json config.json
pnpm dev -- --config ./config.json
```

Build for production:

```bash
pnpm build
pnpm start -- --config ./config.json
```

Point NapCat's OneBot v11 reverse WebSocket to:

```text
ws://127.0.0.1:6701/onebot/v11/ws
```

If the bridge is running in Docker or on another host, replace the host and port with the
address reachable from NapCat, for example:

```text
ws://bridge:6701/onebot/v11/ws
```

## Configuration

Start from `examples/config.example.json`:

```json
{
  "onebot": {
    "host": "127.0.0.1",
    "port": 6701,
    "path": "/onebot/v11/ws",
    "accessToken": null,
    "actionTimeoutMs": 10000
  },
  "mcp": {
    "transport": "stdio",
    "host": "127.0.0.1",
    "port": 6710,
    "path": "/mcp"
  },
  "astral": {
    "appServerUrl": "ws://127.0.0.1:4222",
    "authToken": null,
    "threadId": "REPLACE_WITH_FIXED_ASTRAL_THREAD_ID",
    "cwd": null,
    "model": null,
    "includeImageInputs": true
  },
  "qq": {
    "botUserId": "REPLACE_WITH_BOT_QQ",
    "allowedGroupIds": ["REPLACE_GROUP_ID"],
    "allowedPrivateUserIds": ["REPLACE_USER_ID"],
    "recordUntriggered": true
  },
  "externalEvents": {
    "enabled": true,
    "path": "/api/events",
    "authToken": "REPLACE_WITH_EVENT_API_TOKEN",
    "maxBodyBytes": 65536,
    "debounceMs": 2000,
    "maxBatchEvents": 20,
    "maxBatchBodyChars": 6000
  },
  "storage": {
    "dbPath": "./data/astral-bridge.db",
    "mediaDir": "./media",
    "downloadMedia": false
  }
}
```

Environment overrides:

| Variable | Description |
| --- | --- |
| `ASTRAL_BRIDGE_CONFIG` | Path to the JSON config file. |
| `ASTRAL_BRIDGE_APP_SERVER_URL` | Astral app-server WebSocket URL. |
| `ASTRAL_BRIDGE_APP_SERVER_AUTH_TOKEN` | Bearer token for Astral app-server. |
| `ASTRAL_BRIDGE_THREAD_ID` | Fixed Astral thread/session id. |
| `ASTRAL_BRIDGE_BOT_QQ` | Bot QQ user id. |
| `ASTRAL_BRIDGE_ALLOWED_GROUP_IDS` | Comma-separated allowed group ids. |
| `ASTRAL_BRIDGE_ALLOWED_PRIVATE_USER_IDS` | Comma-separated allowed private user ids. |
| `ASTRAL_BRIDGE_MCP_TRANSPORT` | `stdio` or `http`. |
| `ASTRAL_BRIDGE_EVENT_API_ENABLED` | Enable or disable the external event API. |
| `ASTRAL_BRIDGE_EVENT_API_PATH` | External event API path, default `/api/events`. |
| `ASTRAL_BRIDGE_EVENT_API_TOKEN` | Optional bearer token required by the external event API. |
| `ASTRAL_BRIDGE_EVENT_API_DEBOUNCE_MS` | Window used to merge attention-worthy external events before forwarding to Astral. |
| `ASTRAL_BRIDGE_EVENT_API_MAX_BATCH_EVENTS` | Maximum external events included in one merged Astral turn. Extra events in the same window are counted and omitted. |
| `ASTRAL_BRIDGE_EVENT_API_MAX_BATCH_BODY_CHARS` | Maximum merged event body characters sent to Astral. Longer batches are truncated. |

`recordUntriggered` controls whether non-triggering messages from allowed conversations
are stored. Keeping it enabled lets the agent fetch surrounding context without forwarding
every group message into Astral.

## Web UI

When HTTP MCP is enabled, open:

```http
GET /ui
```

The dashboard polls `GET /api/dashboard/state` and shows NapCat/Astral connection status,
the active Astral turn id when one is running, configured routing, external event API
status, recent conversations, recent stored messages, and recent bridge logs.

## Astral MCP Setup

For stdio MCP, build first and point Astral at the compiled entrypoint:

```toml
[mcp_servers.qq]
command = "node"
args = ["/path/to/astral-bridge/dist/index.js", "--config", "/path/to/astral-bridge/config.json"]
```

Use `node` directly instead of a package-manager wrapper. stdio MCP requires stdout to
contain only JSON-RPC messages.

For container or multi-process deployments, run HTTP MCP:

```json
{
  "mcp": {
    "transport": "http",
    "host": "0.0.0.0",
    "port": 6710,
    "path": "/mcp"
  }
}
```

Then configure Astral:

```toml
[mcp_servers.qq]
url = "http://bridge:6710/mcp"
```

## MCP Tools

| Tool | Purpose |
| --- | --- |
| `qq_send_group_message` | Send a group message with text, images, ordered parts, mentions, or a reply target. |
| `qq_send_private_message` | Send a private message with text, images, ordered parts, or a reply target. |
| `qq_send_group_file` | Upload a local file or URL to a QQ group. |
| `qq_send_private_file` | Upload a local file or URL to a QQ private chat. |
| `qq_get_unread_messages` | Return the unread batch counted by the latest inbound Astral prompt. |
| `qq_get_recent_messages` | Return recent stored messages for one group or private conversation. |
| `qq_get_message` | Return one stored message by OneBot `message_id`. |
| `qq_search_messages` | Search stored text messages in one conversation. |
| `qq_get_conversation_state` | Return bridge state and counts for one conversation. |
| `qq_download_media` | Download a stored image/file attachment into the local media cache. |
| `qq_group_admin_help` | Explain grouped QQ administration tools and actions. |
| `qq_group_member_admin` | Kick, mute/unmute, set admin, set card, set special title, or list muted members. |
| `qq_group_request_admin` | Read or handle group join/invite requests. |
| `qq_group_settings_admin` | Change group name/avatar, whole-group mute, or make the bot leave the group. |
| `qq_group_message_admin` | Recall messages, manage essence messages, check @all quota, or mark group read. |
| `qq_group_notice_admin` | Send, list, or delete group notices. |
| `qq_group_file_admin` | Manage group files and folders. |
| `qq_group_info_admin` | Read group, member, and honor information. |

### Group Administration

Group administration tools are grouped to keep the MCP tool list small. Call
`qq_group_admin_help` to discover action names and required fields. Disbanding groups is
intentionally not implemented; `leave_group` only makes the bot leave the group.

All group-specific administration tools reject `group_id` values outside
`qq.allowedGroupIds` when that allowlist is configured. Actions that mutate group state
require `confirm: true`; use that only after the user explicitly asks for the operation.

### Mentions, Images, and Replies

Use `parts` when a group message needs exact ordering of text, mentions, and images:

```json
[
  { "type": "text", "text": "请 " },
  { "type": "at", "user_id": "TARGET_QQ" },
  { "type": "text", "text": " 看一下 " },
  { "type": "image", "file": "/workspace/result.png" }
]
```

Reply to a specific QQ message by passing `reply_to_message_id` with the OneBot
`message_id` from the inbound prompt or one of the history tools.

Images in outbound messages use OneBot `image` segments. Non-image files use
NapCat-compatible `upload_group_file` and `upload_private_file` actions.

## Message Routing

The bridge only forwards messages from configured QQ targets:

- Group messages: forwarded when the bot is at-mentioned or the message replies to a bot
  message.
- Private messages: forwarded for every message from configured private users.
- Other allowed conversation messages: optionally stored when `recordUntriggered` is true,
  but not forwarded to Astral.

Every forwarded turn includes a `conversation_unread` section. `unread_count` is the
number of stored messages in the same group/private conversation since the previous Astral
prompt, including the current trigger message. The agent can call `qq_get_unread_messages`
when that context is useful; it does not need to call it for every message.

## External Event API

When HTTP MCP is enabled, the same HTTP server can accept generic external events:

```http
GET /api/events/schema
```

Returns a machine-readable OpenAPI 3.1 schema with examples and curl usage.

```http
POST /api/events
Authorization: Bearer REPLACE_WITH_EVENT_API_TOKEN
Content-Type: application/json
```

```json
{
  "source": "minecraft:survival-main",
  "event_type": "player_join",
  "title": "Player joined",
  "body": "Steve joined the server",
  "actor": { "id": "uuid", "name": "Steve" },
  "metadata": { "world": "world", "x": 120, "y": 64, "z": -33 }
}
```

The bridge queues attention-worthy events, merges short bursts into one bounded Astral
turn, and submits that merged event to the fixed Astral thread using the same queue as QQ
messages. Set `wants_agent_attention` to `false` to validate and accept an event without
forwarding it into Astral. Batching is controlled by `externalEvents.debounceMs`,
`externalEvents.maxBatchEvents`, and `externalEvents.maxBatchBodyChars`.

Request fields:

| Field | Required | Description |
| --- | --- | --- |
| `source` | Yes | System or integration name, such as `minecraft:survival-main` or `monitoring`. |
| `event_type` / `type` | No | Event kind. Defaults to `event`. |
| `title` | No | Short title. |
| `body` / `text` | No | Main event text. |
| `severity` | No | Severity label. Defaults to `info`. |
| `actor` | No | Entity that caused the event. |
| `metadata` | No | Structured event details. |
| `dedupe_key` | No | Optional stable key supplied by the caller. |
| `occurred_at` | No | ISO timestamp, Unix seconds, or Unix milliseconds. |
| `wants_agent_attention` | No | Defaults to `true`; set `false` for validation-only events. |
| `id` | No | Caller-supplied event id. A UUID is generated when omitted. |

Successful requests return `202 Accepted` with `{ ok, accepted_for_astral, event }`.
Unauthorized requests return `401` when `externalEvents.authToken` is configured.

## Astral App-Server Behavior

The bridge talks to Astral app-server over WebSocket and uses:

- `initialize`
- `thread/resume`
- `turn/start`
- `turn/steer` when the fixed thread already has an active turn

When starting a turn, the bridge requests `approvalPolicy = "never"` and
`sandboxPolicy = { type = "dangerFullAccess" }`. If you use this mode, isolate Astral at
the container, VM, or host level and only mount directories you are willing to expose.

Server approval requests for command execution and file changes are canceled by default.
QQ sending should happen through the MCP tools and Astral MCP tool approval settings, not
through the bridge approving arbitrary app-server actions.

## Docker and OrbStack

The generic bridge image is defined by `Dockerfile`.

OrbStack deployment templates live under `deploy/orbstack`. They include:

- `bridge`: OneBot reverse WebSocket plus Streamable HTTP MCP.
- `astral-code`: an Ubuntu-based Astral app-server runtime with mapped config, binary,
  source, workspace, and build cache directories.
- `napcat`: NapCat Docker service.

Copy `deploy/orbstack/.env.example` to `.env`, fill in your local values, and read
`deploy/orbstack/README.md` before running the compose stack.

## Security Notes

- Do not commit real QQ ids, app-server tokens, API keys, NapCat WebUI tokens, SQLite
  databases, downloaded media, or local config files.
- Bind services to loopback unless you intentionally need LAN access.
- The app-server danger-full-access mode is powerful. Use a dedicated container or host
  account and mount only the workspace/config directories needed by the agent.
- Review allowed groups and private users before exposing the bot to busy chats.

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
```

Project layout:

```text
src/                 Bridge source
examples/            Example JSON config
deploy/orbstack/     Self-hosted OrbStack deployment template
data/                Runtime SQLite state, ignored by git
media/               Runtime media cache, ignored by git
```

## License

Licensed under the Apache License, Version 2.0. See `LICENSE`.
