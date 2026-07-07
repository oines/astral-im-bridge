import type { StoredMessage } from "./types.js";

export interface TelegramReplyQuoteSummary {
  text: string;
  position_utf16: number | null;
  is_manual: boolean | null;
}

export interface TelegramResolvedReplyQuote {
  text: string;
  position_utf16: number;
}

export function extractTelegramReplyQuote(rawEvent: unknown): TelegramReplyQuoteSummary | null {
  const raw = isRecord(rawEvent) ? rawEvent : {};
  const quote = isRecord(raw.quote) ? raw.quote : null;
  if (!quote || typeof quote.text !== "string" || quote.text.length === 0) {
    return null;
  }
  return {
    text: quote.text,
    position_utf16: integerOrNull(quote.position),
    is_manual: typeof quote.is_manual === "boolean" ? quote.is_manual : null,
  };
}

export function telegramReplyQuoteSourceText(message: StoredMessage): string | null {
  const raw = isRecord(message.rawEvent) ? message.rawEvent : {};
  for (const value of [raw.text, raw.caption, message.text, message.rawMessage]) {
    if (typeof value === "string" && value.length > 0 && value !== "[non-text message]") {
      return value;
    }
  }
  return null;
}

export function resolveTelegramReplyQuote(
  sourceText: string,
  quoteText: string,
  quotePositionUtf16?: number,
): TelegramResolvedReplyQuote {
  if (quoteText.trim().length === 0) {
    throw new Error("reply_quote_text must be non-empty");
  }

  const positions = findQuotePositionsUtf16(sourceText, quoteText);
  if (positions.length === 0) {
    throw new Error("reply_quote_text is not an exact contiguous substring of the replied Telegram message");
  }

  if (quotePositionUtf16 != null) {
    if (!Number.isInteger(quotePositionUtf16) || quotePositionUtf16 < 0) {
      throw new Error("reply_quote_position_utf16 must be a non-negative integer");
    }
    if (sourceText.slice(quotePositionUtf16, quotePositionUtf16 + quoteText.length) !== quoteText) {
      throw new Error(
        `reply_quote_position_utf16 does not point to reply_quote_text; candidate positions_utf16: ${positions.join(", ")}`,
      );
    }
    return {
      text: quoteText,
      position_utf16: quotePositionUtf16,
    };
  }

  if (positions.length > 1) {
    throw new Error(
      `reply_quote_text appears multiple times; pass reply_quote_position_utf16. candidate positions_utf16: ${positions.join(", ")}`,
    );
  }

  return {
    text: quoteText,
    position_utf16: positions[0],
  };
}

export function findQuotePositionsUtf16(sourceText: string, quoteText: string): number[] {
  const positions: number[] = [];
  let offset = 0;
  while (offset <= sourceText.length) {
    const index = sourceText.indexOf(quoteText, offset);
    if (index < 0) {
      break;
    }
    positions.push(index);
    offset = index + Math.max(quoteText.length, 1);
  }
  return positions;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
