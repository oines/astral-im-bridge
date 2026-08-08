import assert from "node:assert/strict";
import test from "node:test";
import { groupMemberListResponse } from "../src/group_admin_tools.ts";
import { qqMessageSendResponse, telegramMessageSendResponse } from "../src/mcp.ts";

test("QQ message send responses contain only ok and message_id", () => {
  assert.deepEqual(
    qqMessageSendResponse({
      status: "ok",
      retcode: 0,
      data: { message_id: 123456 },
      wording: "sent",
    }),
    { ok: true, message_id: "123456" },
  );
});

test("Telegram message send responses contain only ok and message_id", () => {
  assert.deepEqual(
    telegramMessageSendResponse({ message_id: 654321 }),
    { ok: true, message_id: "654321" },
  );
});

test("QQ member list returns all members with compact fields by default", () => {
  const members = Array.from({ length: 88 }, (_, index) => ({
    group_id: 42,
    user_id: 10_000 + index,
    nickname: `nickname-${index}`,
    card: index === 0 ? "group card" : "",
    role: index === 0 ? "owner" : "member",
    title: index === 1 ? "special" : "",
    age: 0,
    sex: "unknown",
    area: "",
    level: "0",
    join_time: 1,
    last_sent_time: 2,
  }));

  const result = groupMemberListResponse(
    { group_id: "42", offset: 0 },
    { status: "ok", retcode: 0, data: members },
  );

  assert.equal(result.total, 88);
  assert.equal(result.returned_count, 88);
  assert.equal("next_offset" in result, false);
  const compact = result.members as Array<Record<string, unknown>>;
  assert.equal(compact.length, 88);
  assert.deepEqual(compact[0], {
    user_id: "10000",
    display_name: "group card",
    nickname: "nickname-0",
    card: "group card",
    role: "owner",
  });
  assert.equal("age" in compact[0], false);
  assert.equal("join_time" in compact[0], false);
});

test("QQ member list supports explicit paging fallback", () => {
  const members = Array.from({ length: 6 }, (_, index) => ({
    user_id: String(index + 1),
    nickname: `member-${index + 1}`,
  }));

  const first = groupMemberListResponse(
    { group_id: "42", offset: 0, limit: 4 },
    { status: "ok", retcode: 0, data: members },
  );
  const second = groupMemberListResponse(
    { group_id: "42", offset: first.next_offset as number, limit: 4 },
    { status: "ok", retcode: 0, data: members },
  );

  assert.equal(first.returned_count, 4);
  assert.equal(first.next_offset, 4);
  assert.equal(second.returned_count, 2);
  assert.equal("next_offset" in second, false);
  assert.deepEqual(
    [...(first.members as Array<{ user_id: string }>), ...(second.members as Array<{ user_id: string }>)]
      .map((member) => member.user_id),
    ["1", "2", "3", "4", "5", "6"],
  );
});
