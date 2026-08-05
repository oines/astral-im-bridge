import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPokeStoredMessage } from "../src/message.ts";
import { runMessageQuery } from "../src/message_query.ts";
import { MessageStore } from "../src/store.ts";
import type { OneBotPokeNoticeEvent } from "../src/types.ts";

test("a group member poking another member is stored as searchable non-triggering history", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astral-bridge-poke-"));
  const dbPath = path.join(dir, "messages.sqlite");
  const store = new MessageStore({
    dbPath,
    mediaDir: path.join(dir, "media"),
    downloadMedia: false,
  });
  const event: OneBotPokeNoticeEvent = {
    post_type: "notice",
    notice_type: "notify",
    sub_type: "poke",
    user_id: "10001",
    target_id: "10002",
    group_id: "728563593",
    self_id: "99999",
    time: 1_700_000_000,
    sender: { nickname: "Alice" },
  };

  const stored = buildPokeStoredMessage(
    event,
    { group_id: "728563593", group_name: "Test Group" },
    "none",
    "99999",
  );
  store.saveMessage(stored);

  assert.equal(stored.trigger, "none");
  assert.equal(stored.text, "[poke] user 10001 poked user 10002 in group 728563593");

  const result = await runMessageQuery(
    dbPath,
    `return search("10002", { platform: "qq", target_id: "728563593", context_limit: 0 });`,
  ) as { hits: Array<Record<string, unknown>> };
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]?.trigger, "none");
  assert.equal(result.hits[0]?.sender_user_id, "10001");
  assert.equal(result.hits[0]?.text, stored.text);
});

test("a group member poking the bot keeps the triggering poke representation", () => {
  const event: OneBotPokeNoticeEvent = {
    post_type: "notice",
    notice_type: "notify",
    sub_type: "poke",
    user_id: "10001",
    target_id: "99999",
    group_id: "728563593",
    self_id: "99999",
    time: 1_700_000_000,
  };

  const stored = buildPokeStoredMessage(event, null, "group_poke", "99999");
  assert.equal(stored.trigger, "group_poke");
  assert.equal(stored.text, "[poke] user 10001 poked bot in group 728563593");
});
