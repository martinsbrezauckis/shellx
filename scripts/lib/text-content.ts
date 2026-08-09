import { readFileSync } from "node:fs";

export function normalizedTextContent(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function readNormalizedTextFileSync(path: string, encoding: "utf8" = "utf8"): string {
  return normalizedTextContent(readFileSync(path, encoding));
}

export function textContentMatches(actual: string, expected: string): boolean {
  return normalizedTextContent(actual) === normalizedTextContent(expected);
}
