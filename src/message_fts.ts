export function buildFtsIndexText(...parts: Array<string | null | undefined>): string {
  const values = parts.map((part) => part?.trim()).filter((part): part is string => !!part);
  const tokens = new Set<string>();
  for (const value of values) {
    for (const token of cjkNgramTokens(value)) {
      tokens.add(token);
    }
  }
  return [...values, ...tokens].join(" ");
}

export function buildFtsMatchQuery(query: string): string {
  const terms = new Set<string>();
  const trimmed = query.trim();
  if (!trimmed) {
    return "";
  }
  terms.add(trimmed);
  for (const term of asciiSearchTerms(trimmed)) {
    terms.add(term);
  }
  for (const term of cjkNgramTokens(trimmed)) {
    terms.add(term);
  }
  return [...terms].map(quoteFtsTerm).join(" OR ");
}

function quoteFtsTerm(term: string): string {
  return `"${term.replaceAll("\"", "\"\"")}"`;
}

function asciiSearchTerms(value: string): string[] {
  return value.match(/[A-Za-z0-9_][A-Za-z0-9_.:-]*/g) ?? [];
}

function cjkNgramTokens(value: string): string[] {
  const tokens = new Set<string>();
  for (const match of value.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)) {
    const run = match[0];
    for (const size of [2, 3]) {
      if (run.length < size) {
        continue;
      }
      for (let i = 0; i <= run.length - size; i += 1) {
        tokens.add(run.slice(i, i + size));
      }
    }
  }
  return [...tokens];
}
