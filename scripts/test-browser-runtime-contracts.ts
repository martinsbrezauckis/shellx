import { normalizeBrowserVaultFillActionResponse } from "../src/browser/api";
import { normalizeBrowserObservation } from "../src/browser/vaultFillCandidates";
import { parseRawEventFrame } from "../src/types/acp";

let failures = 0;

function assert(condition: boolean, label: string): void {
  console.log(`  ${condition ? "✓" : "✗"} ${label}`);
  if (!condition) failures += 1;
}

console.log("\n=== Browser runtime response contracts ===");

assert(parseRawEventFrame(null) === null, "event parser rejects null");
assert(
  parseRawEventFrame({ t: "now", kind: "browser-event", payload: {} }) === null,
  "event parser rejects a non-numeric timestamp",
);
const frame = parseRawEventFrame({ t: 42, kind: "browser-event", payload: { ok: true } });
assert(frame?.kind === "browser-event" && frame.t === 42, "event parser accepts the Debug API frame contract");

const response = normalizeBrowserVaultFillActionResponse({
  ok: true,
  status: "filled",
  observation: {
    url: "https://example.test/login",
    refs: [
      { refId: "ref-password", role: "textbox", label: "Password", editable: true },
      "invalid-ref",
    ],
  },
});
const observation = normalizeBrowserObservation(response.observation);
assert(response.ok === true && response.status === "filled", "Vault fill response fields are validated");
assert(observation?.refs?.length === 1, "observation normalizer drops malformed refs");
assert(observation?.refs?.[0]?.refId === "ref-password", "observation normalizer preserves safe ref fields");

let invalidResponseRejected = false;
try {
  normalizeBrowserVaultFillActionResponse({ ok: "yes" });
} catch {
  invalidResponseRejected = true;
}
assert(invalidResponseRejected, "Vault fill response rejects invalid field types");

if (failures > 0) {
  console.error(`\n${failures} Browser runtime contract assertion(s) failed.`);
  process.exit(1);
}

console.log("\nPASS Browser runtime response contracts");
