# Bridge Event API

Use this API when a script, plugin, game server, monitor, or other external system needs to notify Astral through the bridge.

The current deployment provides credentials in:

```sh
/workspace/.bridge-event-api.env
```

Load it from scripts instead of hard-coding secrets:

```sh
set -a
. /workspace/.bridge-event-api.env
set +a
```

## Endpoint

Machine-readable schema:

```http
GET /api/events/schema
```

```http
POST /api/events
Authorization: Bearer <ASTRAL_BRIDGE_EVENT_API_TOKEN>
Content-Type: application/json
```

Inside the Astral container, use:

```text
http://bridge:6710/api/events
```

From the Mac mini host or LAN, use:

```text
http://10.0.0.10:6710/api/events
```

## Request Body

Required fields:

| Field | Type | Description |
| --- | --- | --- |
| `source` | string | System or integration name, for example `minecraft:survival-main`, `backup`, or `monitoring`. |

Recommended fields:

| Field | Type | Description |
| --- | --- | --- |
| `event_type` | string | Event kind, for example `player_join`, `build_finished`, or `disk_alert`. You can also use `type`. |
| `title` | string | Short display title. |
| `body` | string | Main event text. You can also use `text`. |
| `severity` | string | Severity label. Defaults to `info`. |
| `actor` | object | User, process, or entity that caused the event. |
| `metadata` | object | Structured event details. |
| `dedupe_key` | string | Optional stable key for upstream deduplication. |
| `occurred_at` | string or number | ISO timestamp, Unix seconds, or Unix milliseconds. Defaults to receive time. |
| `wants_agent_attention` | boolean | Defaults to `true`. Set `false` to validate/record an event without triggering Astral. |
| `id` | string | Optional caller-provided event id. A UUID is generated when omitted. |

Unknown JSON fields are accepted but may be ignored by the bridge.

## Example

```sh
set -a
. /workspace/.bridge-event-api.env
set +a

curl -sS -X POST "$ASTRAL_BRIDGE_EVENT_API_URL" \
  -H "Authorization: Bearer $ASTRAL_BRIDGE_EVENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "source": "minecraft:survival-main",
    "event_type": "player_join",
    "title": "Player joined",
    "body": "Steve joined the server",
    "actor": { "id": "uuid", "name": "Steve" },
    "metadata": { "world": "world", "x": 120, "y": 64, "z": -33 }
  }'
```

## Response

Successful requests return `202 Accepted`:

```json
{
  "ok": true,
  "accepted_for_astral": true,
  "event": {
    "id": "generated-or-provided-id",
    "source": "minecraft:survival-main",
    "eventType": "player_join",
    "title": "Player joined",
    "body": "Steve joined the server",
    "severity": "info",
    "actor": { "id": "uuid", "name": "Steve" },
    "metadata": { "world": "world", "x": 120, "y": 64, "z": -33 },
    "dedupeKey": null,
    "occurredAt": "2026-06-19T10:27:02.217Z",
    "receivedAt": "2026-06-19T10:27:02.217Z"
  }
}
```

Common errors:

| Status | Meaning |
| --- | --- |
| `400` | Invalid JSON or missing/invalid fields. |
| `401` | Missing or wrong bearer token. |
| `500` | Bridge failed while processing the event. |

## Agent Behavior

Events are injected into the current Astral session as `[External event]`.

They are not QQ messages. If an event needs a QQ notification, the agent must call QQ MCP send tools. Plain text output is only visible inside Astral and is not sent to QQ.
