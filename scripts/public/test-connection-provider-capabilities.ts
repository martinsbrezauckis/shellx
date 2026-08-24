import assert from "node:assert/strict";
import type {
  ConnectionPreset,
  ConnectionProviderCapabilitySnapshot,
  ConnectionProviderScanEntry,
} from "../../src/components/ConnectionPicker";
import {
  assertConnectionProviderCapabilitySnapshot,
  connectionProviderScanRequestKey,
  CONNECTION_PROVIDER_CAPABILITY_SCHEMA,
  CONNECTION_PROVIDER_CAPABILITY_TTL_MS,
  providerScanStatus,
} from "../../src/lib/connection-provider-capabilities";

const NOW_MS = 1_800_000_100_000;
const PROVIDER_IDS = ["grok", "codex-cli", "claude-code", "antigravity-cli"] as const;

function preset(
  transport: ConnectionPreset["transport"],
): ConnectionPreset {
  return {
    id: "test",
    label: "test target",
    transport,
    createdMs: 1,
    lastUsedMs: 2,
  };
}

function snapshot(
  targetPreset: ConnectionPreset,
  target: ConnectionProviderCapabilitySnapshot["target"],
): ConnectionProviderCapabilitySnapshot {
  const providers = PROVIDER_IDS.map((providerId, index): ConnectionProviderScanEntry => ({
    providerId,
    canRun: true,
    status: "ready",
    binary: `/provider/${providerId}`,
    version: `${providerId} ${index + 1}.0.0`,
    binarySha256: String(index + 1).repeat(64),
    binaryBytes: 4096 + index,
    targetKey: target.key,
    checkedAtMs: NOW_MS - 1_000,
  }));
  const value: ConnectionProviderCapabilitySnapshot = {
    schemaVersion: CONNECTION_PROVIDER_CAPABILITY_SCHEMA,
    generatedAtMs: NOW_MS,
    freshUntilMs: NOW_MS + CONNECTION_PROVIDER_CAPABILITY_TTL_MS,
    target,
    providers,
  };
  assertConnectionProviderCapabilitySnapshot(value, targetPreset, NOW_MS);
  return value;
}

const fixtures = [
  [
    preset({ kind: "local" }),
    { key: "local:linux", transport: "local", runtime: "posix", label: "Local linux" },
  ],
  [
    preset({ kind: "local" }),
    { key: "local:windows", transport: "local", runtime: "windows", label: "Local windows" },
  ],
  [
    preset({ kind: "wsl", distro: "Ubuntu-24.04", grokPath: "" }),
    {
      key: "wsl:ubuntu-24.04",
      transport: "wsl",
      runtime: "posix",
      label: "WSL Ubuntu-24.04",
      wslDistro: "Ubuntu-24.04",
    },
  ],
  [
    preset({
      kind: "ssh",
      host: "User@Example.test",
      port: 2222,
      remoteGrokPath: "grok",
      remoteRuntime: "posix",
    }),
    {
      key: "ssh:posix:User@example.test:2222",
      transport: "ssh",
      runtime: "posix",
      label: "SSH POSIX User@Example.test:2222",
      sshHost: "User@Example.test",
      sshPort: 2222,
    },
  ],
  [
    preset({
      kind: "ssh",
      host: "win.test",
      remoteGrokPath: "grok",
      remoteRuntime: "windows",
    }),
    {
      key: "ssh:windows:win.test:22",
      transport: "ssh",
      runtime: "windows",
      label: "SSH Windows win.test:22",
      sshHost: "win.test",
      sshPort: 22,
    },
  ],
  [
    preset({
      kind: "ssh",
      host: "win.test",
      remoteGrokPath: "grok",
      remoteRuntime: "windows_wsl",
      wslDistro: "Ubuntu",
    }),
    {
      key: "ssh:windows_wsl:win.test:22:wsl=ubuntu",
      transport: "ssh",
      runtime: "windows_wsl",
      label: "SSH Windows WSL win.test:22",
      wslDistro: "Ubuntu",
      sshHost: "win.test",
      sshPort: 22,
    },
  ],
] as const;

for (const [targetPreset, target] of fixtures) {
  snapshot(targetPreset, target);
}

assert.equal(
  connectionProviderScanRequestKey(preset({ kind: "local", grokPath: " C:\\Users\\User\\.grok\\bin\\grok.exe " })),
  JSON.stringify(["local", "C:\\Users\\User\\.grok\\bin\\grok.exe"]),
  "local Windows configured Grok path participates in scan identity",
);
assert.notEqual(
  connectionProviderScanRequestKey(preset({ kind: "wsl", distro: "Ubuntu", grokPath: "/home/shellx-test-user/.grok/bin/grok" })),
  connectionProviderScanRequestKey(preset({ kind: "wsl", distro: "ubuntu", grokPath: "/opt/grok/bin/grok" })),
  "WSL scan identity preserves its configured Linux binary path",
);
assert.equal(
  connectionProviderScanRequestKey(preset({ kind: "wsl", distro: "Ubuntu", grokPath: "grok" })),
  connectionProviderScanRequestKey(preset({ kind: "wsl", distro: "ubuntu", grokPath: "grok" })),
  "equivalent WSL distro casing coalesces",
);
assert.notEqual(
  connectionProviderScanRequestKey(preset({
    kind: "ssh",
    host: "User@WINDOWS.test",
    remoteGrokPath: "C:\\Users\\User\\.grok\\bin\\grok.exe",
    remoteRuntime: "windows",
  })),
  connectionProviderScanRequestKey(preset({
    kind: "ssh",
    host: "User@windows.test",
    remoteGrokPath: "grok",
    remoteRuntime: "windows_wsl",
    wslDistro: "Ubuntu",
  })),
  "native Windows SSH and Windows plus WSL scans cannot share an in-flight result",
);
assert.equal(
  connectionProviderScanRequestKey(preset({
    kind: "ssh",
    host: "User@WINDOWS.test",
    port: 22,
    remoteGrokPath: "grok",
    remoteRuntime: "windows",
  })),
  connectionProviderScanRequestKey(preset({
    kind: "ssh",
    host: "User@windows.test",
    remoteGrokPath: "grok",
    remoteRuntime: "windows",
  })),
  "equivalent Windows SSH host casing and default ports coalesce",
);
assert.notEqual(
  connectionProviderScanRequestKey(preset({
    kind: "ssh",
    host: "User@windows.test",
    keyVaultRef: "connections.windows.primary",
    remoteGrokPath: "grok",
    remoteRuntime: "windows",
  })),
  connectionProviderScanRequestKey(preset({
    kind: "ssh",
    host: "User@windows.test",
    keyVaultRef: "connections.windows.backup",
    remoteGrokPath: "grok",
    remoteRuntime: "windows",
  })),
  "SSH scans using different Vault-backed credentials cannot share an in-flight result",
);

const localPreset = preset({ kind: "local" });
const valid = snapshot(localPreset, {
  key: "local:linux",
  transport: "local",
  runtime: "posix",
  label: "Local linux",
});

function rejects(mutator: (draft: ConnectionProviderCapabilitySnapshot) => void, pattern: RegExp): void {
  const draft = structuredClone(valid);
  mutator(draft);
  assert.throws(
    () => assertConnectionProviderCapabilitySnapshot(draft, localPreset, NOW_MS),
    pattern,
  );
}

rejects((draft) => { draft.target.runtime = "windows"; }, /target mismatch/);
rejects((draft) => { draft.providers.pop(); }, /omitted/);
rejects((draft) => {
  draft.providers[3] = structuredClone(draft.providers.at(0)!);
}, /duplicates/);
rejects((draft) => { draft.freshUntilMs = NOW_MS - 1; }, /stale/);
rejects((draft) => { draft.freshUntilMs += 1; }, /stale/);
rejects((draft) => {
  draft.generatedAtMs = NOW_MS + 6_000;
  draft.freshUntilMs = draft.generatedAtMs + CONNECTION_PROVIDER_CAPABILITY_TTL_MS;
}, /future/);
rejects((draft) => { draft.providers.at(0)!.targetKey = "local:windows"; }, /different target/);
rejects((draft) => {
  draft.providers.at(0)!.checkedAtMs = NOW_MS - CONNECTION_PROVIDER_CAPABILITY_TTL_MS - 1;
}, /invalid checkedAtMs/);
rejects((draft) => { delete draft.providers.at(0)!.version; }, /ready provider/);
rejects((draft) => { delete draft.providers.at(0)!.binarySha256; }, /ready provider/);
rejects((draft) => { draft.providers.at(0)!.binaryBytes = 0; }, /ready provider/);
rejects((draft) => {
  draft.providers.at(0)!.status = "versionFailed";
}, /versionFailed provider/);
rejects((draft) => {
  const row = draft.providers.at(0)!;
  row.status = "identityFailed";
  row.binarySha256 = "";
  row.binaryBytes = 0;
}, /identityFailed provider/);
rejects((draft) => {
  draft.providers.at(0)!.status = "targetUnavailable";
}, /claims runnable evidence/);
rejects((draft) => { draft.target.key = "local:linux|key=ssh\/private"; }, /Vault reference/);

const degraded = structuredClone(valid);
const degradedProvider = degraded.providers.at(0)!;
degradedProvider.status = "canaryFailed";
degradedProvider.canRun = false;
delete degradedProvider.binary;
delete degradedProvider.version;
delete degradedProvider.binarySha256;
delete degradedProvider.binaryBytes;
degradedProvider.detail = "selected endpoint runtime did not pass its bounded canary";
assertConnectionProviderCapabilitySnapshot(degraded, localPreset, NOW_MS);

assert.equal(providerScanStatus({
  providerId: "codex-cli",
  canRun: true,
  version: "codex-cli 1.0.0",
  checkedAtMs: 1,
}), "ready");
assert.equal(providerScanStatus({
  providerId: "codex-cli",
  canRun: true,
  checkedAtMs: 1,
}), "versionFailed");
assert.equal(providerScanStatus({
  providerId: "codex-cli",
  canRun: false,
  checkedAtMs: 1,
}), "missing");

console.log("test-connection-provider-capabilities ok");
