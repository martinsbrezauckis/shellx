import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ReleaseSurfaceCandidateAttestation } from "./lib/release-surface-candidate-attestation";
import {
  parseExactReleaseSurfaceWebDriverBase,
  proveReleaseSurfaceWebDriverBinding,
  releaseSurfaceDriverRequiresNativeWebDriver,
  validateReleaseSurfaceWebDriverBinding,
} from "./lib/release-surface-webdriver-binding";

const candidate: ReleaseSurfaceCandidateAttestation = {
  schema: "shellx/release-surface-candidate-attestation@5",
  mode: "final-frozen-candidate",
  platform: "linux-installed",
  sourceCommit: "b".repeat(40),
  version: "0.3.5",
  createdAt: "2026-07-29T01:00:00.000Z",
  distributionArtifact: { basename: "shellx", sha256: "a".repeat(64), bytes: 100 },
  installation: {
    method: "direct-artifact",
    sourceArtifactSha256: "a".repeat(64),
    receipt: { basename: "installation.json", sha256: "c".repeat(64), bytes: 200 },
    payloadManifestSha256: "d".repeat(64),
  },
  installedPayload: { basename: "shellx", sha256: "a".repeat(64), bytes: 100, path: "/tmp/shellx" },
  process: { pid: 4321, executablePath: "/tmp/shellx", executableSha256: "a".repeat(64) },
  runtime: {
    debugBase: "http://127.0.0.1:30123",
    debugPort: 30123,
    debugTokenPath: "/tmp/token",
    mcpBase: "http://127.0.0.1:30124",
    mcpPort: 30124,
    mcpTokenPath: "/tmp/mcp.token",
    processId: 4321,
    instanceId: "fixture-instance-0001",
    appVersion: "0.3.5",
    buildCommit: "b".repeat(40),
  },
};
const session = { base: "http://127.0.0.1:30444", sessionId: "webdriver-session-0001" };
let challenge: { id: string; label: string } | null = null;
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (url === `${session.base}/session/${session.sessionId}/title`) {
    return jsonResponse({ value: "shellX" });
  }
  if (url === `${session.base}/session/${session.sessionId}/source`) {
    const label = challenge?.label ?? "";
    return jsonResponse({ value: `<html><body><div class="debug-highlight-label">${label}</div></body></html>` });
  }
  if (url === `${candidate.runtime.debugBase}/state/ui` && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      debugHighlights?: Array<{ id?: string; label?: string }>;
    };
    const row = body.debugHighlights?.[0];
    challenge = row?.id && row.label ? { id: row.id, label: row.label } : null;
    return jsonResponse({ ok: true });
  }
  if (url === `${candidate.runtime.debugBase}/state/ui` && method === "GET") {
    return jsonResponse({
      debugHighlightResultsBySurface: {
        app: challenge ? [{ id: challenge.id, status: "resolved" }] : [],
      },
    });
  }
  return new Response("not found", { status: 404 });
};

const evidence = await proveReleaseSurfaceWebDriverBinding({
  candidate,
  candidateToken: "fixture-debug-token-that-is-long-enough",
  session,
  fetchImpl: fakeFetch,
  timeoutMs: 500,
  pollMs: 1,
});
assert.deepEqual(validateReleaseSurfaceWebDriverBinding({ evidence, candidate, session }), []);
assert.equal(evidence.candidate.processId, candidate.runtime.processId);
assert.equal(evidence.webdriver.base, session.base);
assert.equal(evidence.webdriver.titleSha256, createHash("sha256").update("shellX").digest("hex"));
assert.equal(evidence.webdriver.titleBytes, Buffer.byteLength("shellX"));
assert.equal(evidence.challenge.candidateReportedResolved, true);
assert.equal(evidence.challenge.webdriverObservedLabel, true);
assert.equal(evidence.challenge.candidateReportedCleared, true);
assert.equal(evidence.challenge.webdriverObservedCleared, true);
assert.equal(challenge, null, "binding challenge must be removed after proof");
assert(!JSON.stringify(evidence).includes(session.sessionId), "binding evidence stores only the session hash");
assert(!JSON.stringify(evidence).includes("shellX"), "binding evidence stores only the window-title hash");
const titleLeak = structuredClone(evidence) as typeof evidence & { webdriver: typeof evidence.webdriver & { title?: string } };
titleLeak.webdriver.title = "private renderer title";
assert(
  validateReleaseSurfaceWebDriverBinding({ evidence: titleLeak, candidate, session })
    .some((error) => error.includes("undeclared field title")),
  "binding evidence must reject raw renderer title payloads",
);

const drifted = structuredClone(evidence);
drifted.candidate.processId = 9999;
assert(
  validateReleaseSurfaceWebDriverBinding({ evidence: drifted, candidate, session })
    .some((error) => error.includes("processId")),
  "binding evidence from a different candidate process must be rejected",
);
assert.equal(parseExactReleaseSurfaceWebDriverBase("http://127.0.0.1:4444")?.origin, "http://127.0.0.1:4444");
for (const [driverId, kind] of [
  ["shellx-command-installed", "shellx-command"],
  ["ui-control-installed", "ui-control"],
  ["palette-action-installed", "palette-action"],
  ["keyboard-shortcut-installed", "keyboard-shortcut"],
] as const) {
  assert.equal(
    releaseSurfaceDriverRequiresNativeWebDriver(driverId, kind),
    true,
    `${driverId} must receive the same-process native WebDriver binding`,
  );
}
assert.equal(
  releaseSurfaceDriverRequiresNativeWebDriver("tauri-command-installed", "tauri-command"),
  false,
  "the isolated Tauri relay must not request a native WebDriver binding",
);
assert.equal(
  releaseSurfaceDriverRequiresNativeWebDriver("fixture-installed", "tauri-command"),
  false,
  "native binding is selected by the executable driver contract rather than every Tauri-kind fixture",
);
for (const invalid of [
  "http://localhost:4444",
  "http://127.0.0.1:4444/path",
  "http://user:pass@127.0.0.1:4444",
  "https://127.0.0.1:4444",
]) {
  assert.equal(parseExactReleaseSurfaceWebDriverBase(invalid), null, `rejects ambiguous WebDriver base ${invalid}`);
}

console.log("Release surface WebDriver same-process binding tests passed");

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
