import assert from "node:assert/strict";
import test from "node:test";
import { buildRecoveredQqReplyMessage } from "../src/message.ts";
import type { OneBotMessageEvent } from "../src/types.ts";

test("QQ reply recovery preserves the real message id and file attachment", () => {
  const recovered = buildRecoveredQqReplyMessage({
    post_type: "message",
    message_type: "group",
    message_id: 1369403963,
    group_id: 1082162376,
    user_id: 3794477609,
    time: 1_786_379_496,
    sender: {
      user_id: 3794477609,
      nickname: "Astral",
    },
    message: [{
      type: "file",
      data: {
        file: "no_reply_demo_v1.1.zip",
        file_id: "/file-id",
        file_size: 1234,
      },
    }],
    raw_message: "[CQ:file,file=no_reply_demo_v1.1.zip,file_id=/file-id,file_size=1234]",
  }, {
    group_id: "1082162376",
    group_name: "ZnCookie的妈妈们",
    member_count: 89,
    max_member_count: 200,
  }, "group", "1082162376", "3794477609");

  assert.ok(recovered);
  assert.equal(recovered.platformMessageId, "1369403963");
  assert.equal(recovered.trigger, "bot_message");
  assert.equal(recovered.targetId, "1082162376");
  assert.equal(recovered.attachments.length, 1);
  assert.equal(recovered.attachments[0]?.kind, "file");
  assert.equal(recovered.attachments[0]?.fileId, "/file-id");
  assert.equal(recovered.attachments[0]?.name, null);
});

test("QQ reply recovery rejects a fetched message from another group", () => {
  const fetched: OneBotMessageEvent = {
    post_type: "message",
    message_type: "group",
    message_id: 1,
    group_id: 999,
    user_id: 2,
    message: "wrong group",
  };
  assert.equal(
    buildRecoveredQqReplyMessage(fetched, null, "group", "1082162376", "3794477609"),
    null,
  );
});
