import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { synthesizeSpeech } from "../src/tts.ts";
import type { TtsConfig } from "../src/types.ts";

function ttsConfig(patch: Partial<TtsConfig> = {}): TtsConfig {
  return {
    enabled: true,
    protocol: "openai_speech",
    apiKey: null,
    baseUrl: "",
    model: "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16",
    voice: null,
    format: "mp3",
    language: "Chinese",
    referenceAudioPath: "/Users/test/atri.wav",
    referenceText: "参考音频文字",
    timeoutMs: 5_000,
    ...patch,
  };
}

test("openai_speech TTS sends MLX voice-clone fields and accepts binary audio", async () => {
  let requestPath = "";
  let authorization: string | undefined;
  let requestBody: Record<string, unknown> = {};
  const server = http.createServer(async (req, res) => {
    requestPath = req.url ?? "";
    authorization = req.headers.authorization;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    res.writeHead(200, { "content-type": "audio/mpeg" });
    res.end(Buffer.from([1, 2, 3, 4]));
  });
  const baseUrl = await listen(server);

  try {
    const speech = await synthesizeSpeech(ttsConfig({ baseUrl: `${baseUrl}/v1` }), {
      text: "你好，世界。",
      style: "温柔自然",
    });

    assert.equal(requestPath, "/v1/audio/speech");
    assert.equal(authorization, undefined);
    assert.deepEqual(requestBody, {
      model: "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16",
      input: "你好，世界。",
      response_format: "mp3",
      instruct: "温柔自然",
      lang_code: "Chinese",
      ref_audio: "/Users/test/atri.wav",
      ref_text: "参考音频文字",
    });
    assert.deepEqual(speech.buffer, Buffer.from([1, 2, 3, 4]));
    assert.equal(speech.extension, ".mp3");
    assert.equal(speech.mimeType, "audio/mpeg");
  } finally {
    await close(server);
  }
});

test("chat_completions TTS keeps the existing MiMo request and response behavior", async () => {
  let requestPath = "";
  let authorization: string | undefined;
  let requestBody: Record<string, unknown> = {};
  const server = http.createServer(async (req, res) => {
    requestPath = req.url ?? "";
    authorization = req.headers.authorization;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{
        message: {
          audio: {
            data: Buffer.from([5, 6, 7]).toString("base64"),
            format: "wav",
          },
        },
      }],
    }));
  });
  const baseUrl = await listen(server);

  try {
    const speech = await synthesizeSpeech(ttsConfig({
      protocol: "chat_completions",
      apiKey: "secret",
      baseUrl: `${baseUrl}/v1`,
      model: "mimo-v2.5-tts",
      voice: "mimo_default",
      format: "wav",
      language: null,
      referenceAudioPath: null,
      referenceText: null,
    }), {
      text: "测试语音",
    });

    assert.equal(requestPath, "/v1/chat/completions");
    assert.equal(authorization, "Bearer secret");
    assert.deepEqual(requestBody, {
      model: "mimo-v2.5-tts",
      messages: [{ role: "assistant", content: "测试语音" }],
      audio: {
        format: "wav",
        voice: "mimo_default",
      },
    });
    assert.deepEqual(speech.buffer, Buffer.from([5, 6, 7]));
    assert.equal(speech.extension, ".wav");
  } finally {
    await close(server);
  }
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test HTTP server did not return a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}
