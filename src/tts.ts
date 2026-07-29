import type { TtsConfig } from "./types.js";

export interface SynthesizeSpeechOptions {
  text: string;
  style?: string;
}

export interface SynthesizedSpeech {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  format: TtsConfig["format"];
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

const AUDIO_FORMATS: Record<
  TtsConfig["format"],
  { extension: string; mimeType: string }
> = {
  wav: { extension: ".wav", mimeType: "audio/wav" },
  mp3: { extension: ".mp3", mimeType: "audio/mpeg" },
  ogg: { extension: ".ogg", mimeType: "audio/ogg" },
  opus: { extension: ".opus", mimeType: "audio/ogg" },
  m4a: { extension: ".m4a", mimeType: "audio/mp4" },
};

export async function synthesizeSpeech(
  config: TtsConfig,
  options: SynthesizeSpeechOptions,
): Promise<SynthesizedSpeech> {
  if (!config.enabled) {
    throw new Error("TTS is not enabled");
  }
  const text = options.text.trim();
  if (!text) {
    throw new Error("voice text must not be empty");
  }

  if (config.protocol === "openai_speech") {
    return synthesizeOpenAiSpeech(config, text, options.style);
  }
  return synthesizeChatCompletions(config, text, options.style);
}

async function synthesizeChatCompletions(
  config: TtsConfig,
  text: string,
  style?: string,
): Promise<SynthesizedSpeech> {
  if (!config.apiKey) {
    throw new Error("TTS apiKey is not configured");
  }
  if (!config.voice) {
    throw new Error("TTS voice is not configured");
  }

  const response = await fetchWithTimeout(
    `${config.baseUrl}/chat/completions`,
    {
      model: config.model,
      messages: [
        ...(style?.trim() ? [{ role: "user", content: style.trim() }] : []),
        { role: "assistant", content: text },
      ],
      audio: {
        format: config.format,
        voice: config.voice,
      },
    },
    config,
  );
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

  const audio = parsed.choices?.[0]?.message?.audio;
  if (!audio?.data) {
    const message = parsed.error?.message ?? truncate(raw, 500);
    throw new Error(`TTS response did not include audio data: ${message}`);
  }

  const format = audioFormat(audio.format, config.format);
  return speechResult(Buffer.from(audio.data, "base64"), format);
}

async function synthesizeOpenAiSpeech(
  config: TtsConfig,
  text: string,
  style?: string,
): Promise<SynthesizedSpeech> {
  const response = await fetchWithTimeout(
    `${config.baseUrl}/audio/speech`,
    {
      model: config.model,
      input: text,
      response_format: config.format,
      ...(config.voice ? { voice: config.voice } : {}),
      ...(style?.trim() ? { instruct: style.trim() } : {}),
      ...(config.language ? { lang_code: config.language } : {}),
      ...(config.referenceAudioPath ? { ref_audio: config.referenceAudioPath } : {}),
      ...(config.referenceText ? { ref_text: config.referenceText } : {}),
    },
    config,
  );
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`TTS request failed: HTTP ${response.status} ${truncate(raw, 500)}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error("TTS endpoint returned empty audio");
  }
  return speechResult(buffer, config.format);
}

async function fetchWithTimeout(
  url: string,
  body: Record<string, unknown>,
  config: TtsConfig,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }

  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`TTS request timed out after ${config.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function speechResult(
  buffer: Buffer,
  format: TtsConfig["format"],
): SynthesizedSpeech {
  const metadata = AUDIO_FORMATS[format];
  return {
    buffer,
    mimeType: metadata.mimeType,
    extension: metadata.extension,
    format,
  };
}

function audioFormat(
  value: string | undefined,
  fallback: TtsConfig["format"],
): TtsConfig["format"] {
  return value && value in AUDIO_FORMATS
    ? value as TtsConfig["format"]
    : fallback;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
