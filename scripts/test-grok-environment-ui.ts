import { readFileSync } from "node:fs";

const rightRail = readFileSync("src/components/RightRail.tsx", "utf8");
const testSuiteManifest = readFileSync("scripts/test-suite-manifest.mjs", "utf8");

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== Grok environment UI copy ===");

assert(rightRail.includes("function actionableGrokApiKeyHint"), "Grok API-key hint has an actionability gate");
assert(
  rightRail.includes("if (!hint.preferredPresent && !hint.legacyPresent) return null;"),
  "Generic API-key guidance is hidden when no API-key env var is present",
);
assert(!rightRail.includes("<div>{snapshot.apiKeyHint.detail}</div>"), "Raw API-key hint is not rendered directly in the right rail");
assert(
  /const apiKeyHint = actionableGrokApiKeyHint\(snapshot\);[\s\S]*if \(apiKeyHint\)/.test(rightRail),
  "Copied reports/prompts include API-key guidance only when actionable",
);
assert(rightRail.includes("Feature readiness:"), "Environment card renders feature readiness summary");
assert(rightRail.includes("Feature readiness needing attention:"), "Agent-facing environment prompt includes readiness failures");
assert(rightRail.includes("readiness_checks_needing_attention:"), "Copied environment report includes readiness failures");
assert(
  testSuiteManifest.includes('["tsx","scripts/test-grok-environment-ui.ts"]'),
  "Grok environment UI test is wired into pnpm test",
);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} Grok environment UI copy tests`);
process.exit(failures === 0 ? 0 : 1);
