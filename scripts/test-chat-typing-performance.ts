import { readFileSync } from "node:fs";

const app = readFileSync("src/App.tsx", "utf8");
const chatOutput = readFileSync("src/components/ChatOutput.tsx", "utf8");
const packageJson = readFileSync("package.json", "utf8");

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== chat typing performance guards ===");

assert(
  /import\s+\{[^}]*\bmemo\b[^}]*\}\s+from\s+"react"/.test(chatOutput),
  "ChatOutput imports React memo",
);
assert(
  /export\s+const\s+ChatOutput\s*=\s*memo\(/.test(chatOutput),
  "ChatOutput is memoized so unchanged transcripts skip composer keystroke renders",
);
assert(
  /const\s+handlePreviewFile\s*=\s*useCallback\(/.test(app),
  "Preview file callback has stable identity for memoized chat rows",
);
assert(
  /handlePreviewFileImpl\.current\s*=/.test(app),
  "Stable preview callback dispatches through a current implementation ref",
);
assert(
  packageJson.includes("tsx scripts/test-chat-typing-performance.ts"),
  "typing performance guard runs in pnpm test",
);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} chat typing performance guards`);
process.exit(failures === 0 ? 0 : 1);
