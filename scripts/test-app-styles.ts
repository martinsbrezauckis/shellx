import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { APP_STYLE_PATHS, readAppStyles } from "./lib/app-styles";

const entry = readFileSync("src/App.css", "utf8");
const imports = [...entry.matchAll(/^@import\s+"([^"]+)";$/gm)].map((match) =>
  `src/${match[1]!.replace(/^\.\//, "")}`,
);

assert.deepEqual(imports, [...APP_STYLE_PATHS], "App.css must preserve the canonical style order");
for (const path of APP_STYLE_PATHS) {
  const source = readFileSync(path, "utf8");
  assert.ok(source.trim().length > 0, `${path} must not be empty`);
  assert.ok(source.split(/\r?\n/).length <= 2_000, `${path} must stay within 2,000 lines`);
}

const styles = readAppStyles();
for (const selector of [
  ".shell",
  ".bottom-panel",
  ".settings-tab-body",
  ".tooling-pane",
  ".proj-row",
  ".prompt-frame",
]) {
  assert.ok(styles.includes(selector), `${selector} must remain in the split stylesheet`);
}

console.log(`ShellX App styles passed: ${APP_STYLE_PATHS.length} ordered modules`);
