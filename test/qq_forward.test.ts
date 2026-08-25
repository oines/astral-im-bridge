import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { buildAstralPrompt, isQqMergedForward } from "../src/message.ts";
import { compactStoredMessage, createBridgeMcpServer } from "../src/mcp.ts";
import { forwardMessagesFromResponse, OneBotClient } from "../src/onebot.ts";
import { expandQqForwardMessages, findQqForwardNode } from "../src/qq_forward.ts";
import { MessageStore } from "../src/store.ts";
import type { OneBotConfig, StoredMessage } from "../src/types.ts";

test("OneBot get_forward_msg uses the message id and accepts NapCat response shapes", async () => {
  const client = new FakeOneBotClient({
    data: {
      messages: [{ message: "from messages" }],
    },
  });

  assert.deepEqual(await client.getForwardMessage("123"), [{ message: "from messages" }]);
  assert.deepEqual(client.calls, [{ action: "get_forward_msg", params: { message_id: "123" } }]);
  assert.deepEqual(forwardMessagesFromResponse({ data: { message: [{ message: "from message" }] } }), [
    { message: "from message" },
  ]);
  assert.deepEqual(forwardMessagesFromResponse([{ message: "direct" }]), [{ message: "direct" }]);
});

test("merged forwards expand all nested nodes depth-first and stop cycles", async () => {
  const fetched: string[] = [];
  const expansion = await expandQqForwardMessages("outer", async (messageId) => {
    fetched.push(messageId);
    if (messageId === "outer") {
      return [
        {
          sender: { user_id: 1, nickname: "Alice" },
          time: 100,
          message: [{ type: "text", data: { text: "hello" } }],
        },
        {
          user_id: "2",
          nickname: "Bob",
          time: "101",
          message: [
            { type: "at", data: { qq: "1" } },
            { type: "image", data: { file: "image-token", url: "https://example.invalid/a.jpg" } },
            { type: "file", data: { file_id: "file-token", name: "notes.pdf", file_size: 42 } },
            { type: "mystery", data: { value: 1 } },
          ],
        },
        {
          message: [{ type: "forward", data: { id: "nested" } }],
        },
        {
          message: [{
            type: "forward",
            data: {
              id: "inline",
              content: [{
                sender: { user_id: "4", card: "Inline" },
                message: [{ type: "text", data: { text: "inline child" } }],
              }],
            },
          }],
        },
      ];
    }
    if (messageId === "nested") {
      return [
        {
          sender: { user_id: "3", nickname: "Nested" },
          message: [{ type: "text", data: { text: "nested child" } }],
        },
        {
          message: [{ type: "forward", data: { id: "outer" } }],
        },
      ];
    }
    throw new Error(`unexpected fetch ${messageId}`);
  });

  assert.deepEqual(fetched, ["outer", "nested"]);
  assert.deepEqual(
    expansion.nodes.map((node) => node.nodePath),
    ["0", "1", "2", "2/0", "2/1", "3", "3/0"],
  );
  assert.deepEqual(
    expansion.nodes.map((node) => node.depth),
    [0, 0, 0, 1, 1, 0, 1],
  );
  assert.equal(expansion.nodes[0].senderDisplayName, "Alice");
  assert.equal(expansion.nodes[1].attachments.length, 2);
  assert.equal(expansion.nodes[1].attachments[0].kind, "image");
  assert.equal(expansion.nodes[1].attachments[1].name, "notes.pdf");
  assert.deepEqual(expansion.nodes[1].unsupportedSegmentTypes, ["mystery"]);
  assert.equal(findQqForwardNode(expansion, "3/0")?.text, "inline child");
  assert.match(expansion.warnings.join("\n"), /cyclic or repeated forward outer/);
  assert.throws(() => findQqForwardNode(expansion, "3/nope"), /zero-based indexes/);
});

test("merged forwards recover ordered media from CQ-string child messages", async () => {
  const expansion = await expandQqForwardMessages("outer", async () => [{
    user_id: "2",
    message: "hello[CQ:at,qq=1][CQ:image,file=image-token,url=https://example.invalid/a.jpg][CQ:record,file=voice-token]",
  }]);

  assert.equal(expansion.nodes[0].text, "hello[CQ:at,qq=1][CQ:image,file=image-token][record]");
  assert.deepEqual(
    expansion.nodes[0].attachments.map((attachment) => [attachment.kind, attachment.fileId]),
    [["image", "image-token"], ["record", "voice-token"]],
  );
});

test("QQ inbound prompt marks merged forwards without injecting child content", () => {
  const stored = qqMessage({
    rawMessage: "[CQ:forward,id=forward-1]",
    rawEvent: {
      message: [{
        type: "forward",
        data: {
          id: "forward-1",
          content: [{ message: [{ type: "text", data: { text: "hidden child" } }] }],
        },
      }],
    },
  });

  assert.equal(isQqMergedForward(stored), true);
  const prompt = buildAstralPrompt(stored);
  assert.match(prompt, /message_type: merged_forward/);
  assert.match(prompt, /content:\n\[CQ:forward,id=forward-1\]/);
  assert.doesNotMatch(prompt, /hidden child/);
  assert.deepEqual(compactStoredMessage(stored).forward, { expandable: true });
});

test("MCP expands only stored allowlisted forwards without persisting child nodes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astral-forward-mcp-"));
  const configPath = path.join(dir, "bridge.json");
  fs.writeFileSync(configPath, JSON.stringify({
    qq: {
      enabled: true,
      botUserId: "999",
      allowedGroupIds: ["allowed"],
    },
    storage: {
      dbPath: path.join(dir, "bridge.db"),
      mediaDir: path.join(dir, "media"),
    },
  }));
  const config = loadConfig(["--config", configPath]);
  const store = new MessageStore(config.storage);
  store.saveMessage(qqMessage({
    platformMessageId: "outer",
    targetId: "allowed",
    groupId: "allowed",
  }));
  store.saveMessage(qqMessage({
    platformMessageId: "blocked",
    targetId: "blocked-group",
    groupId: "blocked-group",
  }));
  const childImagePath = path.join(dir, "child.jpg");
  fs.writeFileSync(childImagePath, "image");
  const onebot = new FakeOneBotClient({
    data: {
      messages: [{
        message_id: "child",
        sender: { user_id: "7", nickname: "Child" },
        message: [
          { type: "text", data: { text: "child-only-content" } },
          { type: "image", data: { file: childImagePath, path: childImagePath } },
        ],
      }],
    },
  });
  const server = createBridgeMcpServer(config, onebot, null, store);
  const tools = Reflect.get(server, "_registeredTools") as Record<string, {
    handler: (args: Record<string, unknown>) => Promise<{ structuredContent: Record<string, unknown> }>;
  }>;

  const result = await tools.qq_get_forward_messages.handler({ message_id: "outer" });
  assert.equal(result.structuredContent.total_nodes, 1);
  assert.equal(store.findMessagesByPlatformMessageId("child", "qq").length, 0);
  assert.equal(store.searchMessages("qq", "group", "allowed", "child-only-content", 10).length, 0);
  const download = await tools.qq_download_media.handler({
    message_id: "outer",
    forward_node_path: "0",
    attachment_index: 0,
  });
  assert.equal(download.structuredContent.path, childImagePath);
  await assert.rejects(
    tools.qq_download_media.handler({
      message_id: "outer",
      forward_node_path: "1/0",
      attachment_index: 0,
    }),
    /forward node not found/,
  );
  await assert.rejects(
    tools.qq_get_forward_messages.handler({ message_id: "missing" }),
    /stored QQ message not found/,
  );
  await assert.rejects(
    tools.qq_get_forward_messages.handler({ message_id: "blocked" }),
    /outside the configured whitelist/,
  );
});

class FakeOneBotClient extends OneBotClient {
  readonly calls: Array<{ action: string; params: Record<string, unknown> }> = [];

  constructor(private readonly response: unknown) {
    super(oneBotConfig());
  }

  override async callAction<T = unknown>(action: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ action, params });
    return this.response as T;
  }
}

function oneBotConfig(): OneBotConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    path: "/onebot",
    accessToken: null,
    actionTimeoutMs: 1_000,
  };
}

function qqMessage(overrides: Partial<StoredMessage>): StoredMessage {
  return {
    platform: "qq",
    platformMessageId: "100",
    sourceType: "group",
    targetId: "728563593",
    groupId: "728563593",
    groupName: "AstralOps",
    userId: "6995308224",
    nickname: "oines",
    groupCard: "oines",
    role: "admin",
    time: 1_750_000_000,
    text: "",
    rawMessage: "[CQ:forward,id=forward-1]",
    trigger: "keyword",
    replyToMessageId: null,
    rawEvent: {},
    attachments: [],
    ...overrides,
  };
}
