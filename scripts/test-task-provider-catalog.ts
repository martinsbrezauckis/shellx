import assert from "node:assert/strict";
import type {
  ConnectionPreset,
  ConnectionProviderCapabilityTarget,
} from "../src/components/ConnectionPicker";
import {
  assertTaskProviderCatalog,
  TASK_PROVIDER_CATALOG_SCHEMA,
  TASK_PROVIDER_CATALOG_TTL_MS,
  type TaskProviderCatalog,
} from "../src/lib/task-provider-catalog";

const NOW_MS = 1_800_000_100_000;
const PROVIDER_IDS = ["grok", "codex-cli", "claude-code", "antigravity-cli"] as const;

function preset(transport: ConnectionPreset["transport"]): ConnectionPreset {
  return { id: "task-target", label: "Task target", transport, createdMs: 1, lastUsedMs: 2 };
}

function catalogue(
  target: ConnectionProviderCapabilityTarget,
): TaskProviderCatalog {
  return {
    schemaVersion: TASK_PROVIDER_CATALOG_SCHEMA,
    snapshotId: `sha256:${"a".repeat(64)}`,
    generatedAtMs: NOW_MS,
    freshUntilMs: NOW_MS + TASK_PROVIDER_CATALOG_TTL_MS,
    target,
    providers: PROVIDER_IDS.map((providerId, index) => ({
      providerId,
      label: providerId,
      availability: {
        status: "ready",
        canRun: true,
        version: `${providerId} ${index + 1}.0`,
        detail: "",
        checkedAtMs: NOW_MS - 1_000,
      },
      capabilityGuidance: [{
        id: "task-guidance",
        label: "Task guidance",
        level: "observable",
        sourceCardIds: [`${providerId}-card`],
      }],
      models: [],
      defaultModelMode: "providerDefault",
    })),
  };
}

const fixtures: Array<[ConnectionPreset, ConnectionProviderCapabilityTarget]> = [
  [
    preset({ kind: "local" }),
    { key: "local:linux", transport: "local", runtime: "posix", label: "Local linux" },
  ],
  [
    preset({ kind: "wsl", distro: "Ubuntu", grokPath: "grok" }),
    { key: "wsl:ubuntu", transport: "wsl", runtime: "posix", label: "WSL Ubuntu", wslDistro: "Ubuntu" },
  ],
  [
    preset({ kind: "ssh", host: "host.test", remoteGrokPath: "grok", remoteRuntime: "posix" }),
    { key: "ssh:posix:host.test:22", transport: "ssh", runtime: "posix", label: "SSH POSIX host.test:22" },
  ],
  [
    preset({ kind: "ssh", host: "host.test", remoteGrokPath: "grok", remoteRuntime: "windows" }),
    { key: "ssh:windows:host.test:22", transport: "ssh", runtime: "windows", label: "SSH Windows host.test:22" },
  ],
  [
    preset({
      kind: "ssh",
      host: "host.test",
      remoteGrokPath: "grok",
      remoteRuntime: "windows_wsl",
      wslDistro: "Ubuntu",
    }),
    {
      key: "ssh:windows_wsl:host.test:22:wsl=ubuntu",
      transport: "ssh",
      runtime: "windows_wsl",
      label: "SSH Windows WSL host.test:22",
      wslDistro: "Ubuntu",
    },
  ],
];

for (const [targetPreset, target] of fixtures) {
  assertTaskProviderCatalog(catalogue(target), targetPreset, NOW_MS);
}

const localPreset = fixtures[0]![0];
const localCatalogue = catalogue(fixtures[0]![1]);

function rejects(mutator: (draft: TaskProviderCatalog) => void, pattern: RegExp): void {
  const draft = structuredClone(localCatalogue);
  mutator(draft);
  assert.throws(() => assertTaskProviderCatalog(draft, localPreset, NOW_MS), pattern);
}

rejects((draft) => { draft.freshUntilMs = NOW_MS - 1; }, /stale/);
rejects((draft) => { draft.snapshotId = "scan-1"; }, /snapshot identity/);
rejects((draft) => { draft.target.key = "wsl:ubuntu"; }, /target mismatch/);
rejects((draft) => { draft.providers[0]!.providerId = "claude-code"; }, /duplicates/);
rejects((draft) => { draft.providers.pop(); }, /omitted/);
rejects((draft) => { draft.providers[0]!.models.push({ id: "guessed", label: "Guessed", source: "card" }); }, /unverified model/);
rejects((draft) => { (draft.providers[0]! as { defaultModelMode: string }).defaultModelMode = "selectedModel"; }, /model mode/);
rejects((draft) => { draft.providers[0]!.availability.checkedAtMs = NOW_MS - TASK_PROVIDER_CATALOG_TTL_MS - 1; }, /checkedAtMs/);

const missingButGuided = structuredClone(localCatalogue);
missingButGuided.providers[0]!.availability = {
  status: "missing",
  canRun: false,
  detail: "No supported CLI binary resolved on this exact target.",
  checkedAtMs: NOW_MS - 1_000,
};
assertTaskProviderCatalog(missingButGuided, localPreset, NOW_MS);

console.log("test-task-provider-catalog ok");
