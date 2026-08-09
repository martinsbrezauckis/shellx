import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { normalizedTextContent } from "./lib/text-content";

export function readRustModuleFamily(rootFile: string): string {
  const directory = dirname(rootFile);
  const extension = extname(rootFile);
  const stem = basename(rootFile, extension);
  const modulePrefix = `${stem}_`;
  const files = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(extension) &&
        (entry.name === `${stem}${extension}` || entry.name.startsWith(modulePrefix)),
    )
    .map((entry) => entry.name)
    .sort();

  return normalizedTextContent(files.map((file) => readFileSync(join(directory, file), "utf8")).join("\n"));
}
