export interface DebugApiRoutePair {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
}

export function extractDebugApiRoutePairs(text: string): DebugApiRoutePair[] {
  const rows: DebugApiRoutePair[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const routeIndex = findNextRustCodeToken(text, ".route", cursor);
    if (routeIndex < 0) break;
    let open = routeIndex + ".route".length;
    open = skipRustTrivia(text, open);
    if (text[open] !== "(") {
      cursor = open + 1;
      continue;
    }
    const close = findMatchingRustParen(text, open);
    if (close < 0) throw new Error(`Unbalanced .route call at source offset ${routeIndex}`);
    const args = text.slice(open + 1, close);
    const comma = findTopLevelRustComma(args);
    if (comma < 0) throw new Error(`Could not split .route arguments at source offset ${routeIndex}`);
    const path = parseRustStringLiteral(args.slice(0, comma));
    if (!path) throw new Error(`Debug API .route path must be one static string at source offset ${routeIndex}`);
    for (const method of collectRustCallIdentifiers(args.slice(comma + 1))) {
      if (method === "get" || method === "post" || method === "put" || method === "patch" || method === "delete") {
        rows.push({ method: method.toUpperCase() as DebugApiRoutePair["method"], path });
      }
    }
    cursor = close + 1;
  }
  return rows;
}

function findNextRustCodeToken(text: string, token: string, start: number): number {
  for (let index = start; index < text.length;) {
    const skipped = skipRustNonCode(text, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (text.startsWith(token, index)) return index;
    index += 1;
  }
  return -1;
}

function findMatchingRustParen(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const skipped = skipRustNonCode(text, index);
    if (skipped > index) {
      index = skipped - 1;
      continue;
    }
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findTopLevelRustComma(text: string): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = 0; index < text.length; index += 1) {
    const skipped = skipRustNonCode(text, index);
    if (skipped > index) {
      index = skipped - 1;
      continue;
    }
    const char = text[index];
    if (char === "(") paren += 1;
    else if (char === ")") paren -= 1;
    else if (char === "[") bracket += 1;
    else if (char === "]") bracket -= 1;
    else if (char === "{") brace += 1;
    else if (char === "}") brace -= 1;
    else if (char === "," && paren === 0 && bracket === 0 && brace === 0) return index;
  }
  return -1;
}

function collectRustCallIdentifiers(text: string): string[] {
  const rows: string[] = [];
  for (let index = 0; index < text.length;) {
    const skipped = skipRustNonCode(text, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (!/[A-Za-z_]/.test(text[index] ?? "")) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (/[A-Za-z0-9_]/.test(text[end] ?? "")) end += 1;
    const identifier = text.slice(index, end);
    if (text[skipRustTrivia(text, end)] === "(") rows.push(identifier);
    index = end;
  }
  return rows;
}

function parseRustStringLiteral(text: string): string | null {
  const start = skipRustTrivia(text, 0);
  if (text[start] === '"') {
    let escaped = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (!escaped && char === '"') {
        try {
          return JSON.parse(text.slice(start, index + 1)) as string;
        } catch {
          return null;
        }
      }
      if (!escaped && char === "\\") escaped = true;
      else escaped = false;
    }
    return null;
  }
  const raw = text.slice(start).match(/^r(#+)?"/);
  if (!raw) return null;
  const hashes = raw[1] ?? "";
  const bodyStart = start + raw[0].length;
  const end = text.indexOf(`"${hashes}`, bodyStart);
  return end < 0 ? null : text.slice(bodyStart, end);
}

function skipRustTrivia(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    if (/\s/.test(text[index] ?? "")) {
      index += 1;
      continue;
    }
    const skipped = skipRustComment(text, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    break;
  }
  return index;
}

function skipRustNonCode(text: string, index: number): number {
  const comment = skipRustComment(text, index);
  if (comment > index) return comment;
  const raw = text.slice(index).match(/^(?:b|br)?r(#+)?"/);
  if (raw) {
    const hashes = raw[1] ?? "";
    const end = text.indexOf(`"${hashes}`, index + raw[0].length);
    return end < 0 ? text.length : end + hashes.length + 1;
  }
  const quote = text[index];
  const byteString = quote === "b" && (text[index + 1] === '"' || text[index + 1] === "'");
  const quoteIndex = byteString ? index + 1 : index;
  const delimiter = text[quoteIndex];
  if (delimiter !== '"' && !(delimiter === "'" && !/[A-Za-z_]/.test(text[quoteIndex + 1] ?? ""))) return index;
  let escaped = false;
  for (let cursor = quoteIndex + 1; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (!escaped && char === delimiter) return cursor + 1;
    if (!escaped && char === "\\") escaped = true;
    else escaped = false;
  }
  return text.length;
}

function skipRustComment(text: string, index: number): number {
  if (text.startsWith("//", index)) {
    const end = text.indexOf("\n", index + 2);
    return end < 0 ? text.length : end + 1;
  }
  if (!text.startsWith("/*", index)) return index;
  let depth = 1;
  let cursor = index + 2;
  while (cursor < text.length && depth > 0) {
    if (text.startsWith("/*", cursor)) {
      depth += 1;
      cursor += 2;
    } else if (text.startsWith("*/", cursor)) {
      depth -= 1;
      cursor += 2;
    } else cursor += 1;
  }
  return cursor;
}
