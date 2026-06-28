import type { TtsConfig } from "./types.js";

export interface SynthesizeSpeechOptions {
  text: string;
  style?: string;
}

export interface SynthesizedSpeech {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  format: string;
}

interface ChatCompletionsTtsResponse {
  choices?: Array<{
    message?: {
      audio?: {
        data?: string;
        format?: string;
      };
    };
  }>;
  error?: {
    message?: string;
  };
}

export async function synthesizeSpeech(
  config: TtsConfig,
  options: SynthesizeSpeechOptions,
): Promise<SynthesizedSpeech> {
  if (!config.enabled) {
    throw new Error("TTS is not enabled");
  }
  if (!config.apiKey) {
    throw new Error("TTS apiKey is not configured");
  }
  const text = options.text.trim();
  if (!text) {
    throw new Error("voice text must not be empty");
  }

  const body = {
    model: config.model,
    messages: [
      ...(options.style?.trim()
        ? [{ role: "user", content: options.style.trim() }]
        : []),
      { role: "assistant", content: text },
    ],
    audio: {
      format: config.format,
      voice: config.voice,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`TTS request failed: HTTP ${response.status} ${truncate(raw, 500)}`);
    }

    let parsed: ChatCompletionsTtsResponse;
    try {
      parsed = JSON.parse(raw) as ChatCompletionsTtsResponse;
    } catch (err) {
      throw new Error(`TTS endpoint returned invalid JSON: ${String(err)}`);
    }

    const data = parsed.choices?.[0]?.message?.audio?.data;
    if (!data) {
      const message = parsed.error?.message ?? truncate(raw, 500);
      throw new Error(`TTS response did not include audio data: ${message}`);
    }

    return {
      buffer: Buffer.from(data, "base64"),
      mimeType: "audio/wav",
      extension: ".wav",
      format: config.format,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`TTS request timed out after ${config.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
