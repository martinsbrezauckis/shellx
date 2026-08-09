import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import {
  abandonClipboardLifecycle,
  clipboardExpectedMetadata,
  preflightClipboardLifecycle,
  releaseUnusedClipboardLifecycle,
  verifyAndClearClipboardLifecycle,
} from "./release-drivers/clipboard-lifecycle-client";
import { CLIPBOARD_LIFECYCLE_SURFACE_IDS } from "./release-drivers/ui-control-clipboard-lifecycle";

const root = resolve(import.meta.dirname, "..");
const plan = JSON.parse(readFileSync(resolve(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
const driverId = "ui-control-clipboard-lifecycle-installed";
const ownedValue = "clipboard-owned-lifecycle-fixture";

const assignments = plan.assignments.filter((assignment) => assignment.driverId === driverId);
assert.equal(assignments.length, 20);
assert.deepEqual(new Set(assignments.map((assignment) => assignment.surfaceId)), CLIPBOARD_LIFECYCLE_SURFACE_IDS);
assert(assignments.every((assignment) => (
  assignment.fixtureId === "ui:owned-native-clipboard-empty-lifecycle"
  && assignment.oracleId === "ui:activation:native-clipboard-owned-value-verified-and-cleared"
  && assignment.cleanupId === "ui:clear-owned-clipboard-prove-empty-and-restore-surface"
)));
const driver = plan.drivers.find((candidate) => candidate.id === driverId);
assert(driver);
assert.deepEqual(driver.platforms, {
  "windows-installed": "ready",
  "macos-installed": "ready",
  "linux-installed": "ready",
});

assert(assignments.some((assignment) => (
  assignment.surfaceId === 'ui-control:src/components/settings/VaultTab.tsx:[aria-label^="Copy value for "]@src/components/settings/VaultTab.tsx#8'
)), "trusted raw-secret copy must use the owned native clipboard lifecycle");

const nativeSource = readFileSync(resolve(root, "src-tauri/src/debug_api_release_clipboard.rs"), "utf8");
assert(nativeSource.includes("CountClipboardFormats"));
assert(nativeSource.includes("NSPasteboard"));
assert(nativeSource.includes("get_selection_owner"));
assert(nativeSource.includes("Zeroizing::new(backend.read_text()?"));
assert(!nativeSource.includes("clipboard_text:"));
const responseStruct = nativeSource.slice(
  nativeSource.indexOf("struct ClipboardResponse"),
  nativeSource.indexOf("struct ClipboardError"),
);
assert(!responseStruct.includes("sha256"), "response must not serialize a clipboard hash");

const fixture = await startClipboardFixture();
try {
  const connection = { base: fixture.base, token: fixture.token };

  fixture.state.value = "operator-value";
  fixture.state.formats = 1;
  await assert.rejects(preflightClipboardLifecycle(connection, ownedValue), /release_clipboard_not_empty/);
  assert.equal(fixture.state.reads, 0, "nonempty preflight must not read operator clipboard payload");
  assert.equal(fixture.state.clears, 0, "nonempty preflight must not clear operator clipboard payload");
  assert.equal(fixture.state.value, "operator-value");

  fixture.reset();
  const mismatchLease = await preflightClipboardLifecycle(connection, ownedValue);
  fixture.state.value = "changed-after-preflight";
  fixture.state.formats = 1;
  await assert.rejects(verifyAndClearClipboardLifecycle(connection, mismatchLease), /owned_value_mismatch/);
  assert.equal(fixture.state.clears, 0, "mismatched clipboard must be preserved");
  assert.equal(fixture.state.value, "changed-after-preflight");
  await abandonClipboardLifecycle(connection, mismatchLease);
  assert.equal(fixture.state.value, "changed-after-preflight", "lease abandonment must not touch clipboard contents");
  fixture.reset();

  const successLease = await preflightClipboardLifecycle(connection, ownedValue);
  fixture.state.value = ownedValue;
  fixture.state.formats = 1;
  await verifyAndClearClipboardLifecycle(connection, successLease);
  assert.equal(fixture.state.reads, 2, "verify and compare-before-clear must each read internally");
  assert.equal(fixture.state.clears, 1);
  assert.equal(fixture.state.formats, 0);
  assert.equal(fixture.state.value, "");

  const unusedLease = await preflightClipboardLifecycle(connection, ownedValue);
  await releaseUnusedClipboardLifecycle(connection, unusedLease);
  assert.equal(fixture.state.reads, 2, "unused empty lease release must not read payload");

  const auditText = JSON.stringify(fixture.state.audit);
  assert(!auditText.includes(ownedValue), "owned clipboard fixture must not enter audit output");
  assert(!auditText.includes(createHash("sha256").update(ownedValue).digest("hex")), "clipboard hash must not enter audit output");
  assert.deepEqual(clipboardExpectedMetadata(ownedValue), {
    expectedSha256: createHash("sha256").update(ownedValue).digest("hex"),
    expectedBytes: Buffer.byteLength(ownedValue),
  });
} finally {
  await fixture.close();
}

console.log("Release clipboard lifecycle passed: 20 owned controls, fail-closed native preflight, mismatch preservation, verified clear, and synthetic Vault values never enter reports");

async function startClipboardFixture(): Promise<{
  base: string;
  token: string;
  state: ClipboardFixtureState;
  reset: () => void;
  close: () => Promise<void>;
}> {
  const token = "clipboard-fixture-token";
  const state: ClipboardFixtureState = emptyState();
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}` || request.method !== "POST" || request.url !== "/release-test/clipboard") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const action = String(body.action ?? "");
    state.audit.push({ action, formats: state.formats });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (action === "preflight") {
      if (state.formats !== 0) return send(409, { error: "release_clipboard_not_empty" });
      if (state.lease) return send(409, { error: "release_clipboard_lease_active" });
      state.lease = `rcb-${"a".repeat(32)}`;
      return send(200, { ok: true, action, empty: true, leaseId: state.lease });
    }
    if (body.leaseId !== state.lease || !state.lease) return send(404, { error: "release_clipboard_lease_not_found" });
    if (action === "releaseEmpty") {
      if (state.formats !== 0) return send(409, { error: "release_clipboard_not_empty" });
      state.lease = null;
      return send(200, { ok: true, action, empty: true });
    }
    if (action === "abandon") {
      state.lease = null;
      return send(200, { ok: true, action, empty: false });
    }
    const matches = () => {
      state.reads += 1;
      return body.expectedBytes === Buffer.byteLength(state.value)
        && body.expectedSha256 === createHash("sha256").update(state.value).digest("hex");
    };
    if (action === "verify") {
      if (!matches()) return send(409, { error: "release_clipboard_owned_value_mismatch" });
      state.verified = true;
      return send(200, { ok: true, action, empty: false, verified: true });
    }
    if (action === "clear") {
      if (!state.verified || !matches()) return send(409, { error: "release_clipboard_owned_value_mismatch" });
      state.value = "";
      state.formats = 0;
      state.clears += 1;
      state.lease = null;
      return send(200, { ok: true, action, empty: true, cleared: true });
    }
    return send(400, { error: "release_clipboard_action_invalid" });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("clipboard fixture did not bind TCP");
  return {
    base: `http://127.0.0.1:${address.port}`,
    token,
    state,
    reset: () => Object.assign(state, emptyState()),
    close: () => new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())),
  };
}

type ClipboardFixtureState = {
  formats: number;
  value: string;
  lease: string | null;
  verified: boolean;
  reads: number;
  clears: number;
  audit: Array<{ action: string; formats: number }>;
};

function emptyState(): ClipboardFixtureState {
  return { formats: 0, value: "", lease: null, verified: false, reads: 0, clears: 0, audit: [] };
}
