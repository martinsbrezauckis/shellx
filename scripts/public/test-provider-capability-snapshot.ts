import assert from "node:assert/strict";

import {
  buildProviderCapabilitySnapshot,
  buildProviderCapabilityDashboard,
  detectMarkers,
  extractBundledCardsVersion,
  renderProviderCapabilityReport,
  summarizeProviderCapabilities,
  type CliProbeResult,
  type ProviderCapabilityProbe,
  type ProviderCapabilitySnapshot,
} from "../../src/lib/provider-capability-snapshot";

assert.deepEqual(detectMarkers("codex exec --json --skip-git-repo-check", ["--json", "--missing"]), [
  { marker: "--json", present: true },
  { marker: "--missing", present: false },
]);

assert.equal(
  extractBundledCardsVersion('pub const MODEL_INSTRUCTION_CARDS_VERSION: &str = "2026-06-03.1";'),
  "2026-06-03.1",
);

const fakeRunner = async (binary: string, args: string[]): Promise<CliProbeResult> => {
  const key = `${binary} ${args.join(" ")}`;
  const stdout: Record<string, string> = {
    "grok --version": "grok 0.2.20\n",
    "grok --help": "Usage: grok --resume --continue agent mcp inspect trace\n",
    "grok mcp --help": "Usage: grok mcp doctor\n",
    "codex --version": "codex-cli 1.2.3\n",
    "codex exec --help": "Usage: codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check\n",
    "codex exec resume --help": "Usage: codex exec resume --json\n",
    "claude --version": "claude-code 4.5.6\n",
    "claude -p --help": "Usage: claude -p --output-format stream-json --include-partial-messages --permission-mode --mcp-config --resume\n",
  };
  if (binary === "agy") {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      errorCode: "ENOENT",
      errorMessage: `${binary} not found`,
    };
  }
  return {
    ok: Boolean(stdout[key]),
    exitCode: stdout[key] ? 0 : 2,
    stdout: stdout[key] ?? "",
    stderr: "",
    timedOut: false,
  };
};

const snapshot = await buildProviderCapabilitySnapshot({
  runner: fakeRunner,
  generatedAt: "2026-06-03T00:00:00.000Z",
  cardsVersion: "test-cards",
});

assert.equal(snapshot.schemaVersion, "shellx-provider-capabilities.v1");
assert.equal(snapshot.cardsVersion, "test-cards");

const codex = snapshot.providers.find((provider) => provider.id === "codex-cli");
assert(codex, "codex provider is present");
assert.equal(codex.status, "ready");
assert.equal(codex.binaries[0]?.version, "codex-cli 1.2.3");

const grok = snapshot.providers.find((provider) => provider.id === "grok");
assert(grok, "grok provider is present");
assert.equal(grok.status, "ready");
assert(
  grok.binaries[0]?.help[0]?.markers.some((marker) => marker.marker === "--resume" && marker.present),
  "grok top-level help advertises native resume",
);

const claude = snapshot.providers.find((provider) => provider.id === "claude-code");
assert(claude, "claude provider is present");
assert.equal(claude.status, "review", "missing one expected help marker should request review");

const agy = snapshot.providers.find((provider) => provider.id === "antigravity-cli");
assert(agy, "antigravity provider is present");
assert.equal(agy.status, "missing");
assert.equal(agy.binaries[0]?.available, false);

const summary = summarizeProviderCapabilities(snapshot);

assert.equal(summary.overallStatus, "review", "any review provider sets overall review");
assert.deepEqual(
  summary.counts,
  { ready: 2, review: 1, missing: 1 },
  "summary counts match fixture statuses",
);

const claudeFinding = summary.findings.find((finding) => finding.id === "claude-code");
assert(claudeFinding, "claude finding present");
assert.equal(claudeFinding.status, "review");
assert(
  claudeFinding.missingMarkers.some(
    (marker) =>
      marker.marker === "--include-hook-events" &&
      marker.binary === "claude" &&
      marker.helpId === "print",
  ),
  "claude review finding names the exact missing marker and help surface",
);
assert(
  claudeFinding.recommendation.includes("--include-hook-events") &&
    claudeFinding.recommendation.includes("claude-code"),
  "claude recommendation names the drifted marker and the bundled card to update",
);

const agyFinding = summary.findings.find((finding) => finding.id === "antigravity-cli");
assert(agyFinding, "antigravity finding present");
assert.equal(agyFinding.status, "missing");
assert.deepEqual(agyFinding.missingBinaries, ["agy"], "missing provider lists absent binary");
assert.equal(agyFinding.missingMarkers.length, 0, "missing provider probes no markers");

const codexFinding = summary.findings.find((finding) => finding.id === "codex-cli");
assert(codexFinding, "codex finding present");
assert.equal(codexFinding.status, "ready");
assert.equal(codexFinding.version, "codex-cli 1.2.3", "ready finding carries the version line");
assert.equal(codexFinding.missingMarkers.length, 0, "ready finding has no missing markers");

const report = renderProviderCapabilityReport(summary);
assert(report.includes("ShellX provider capability report"), "report has a title");
assert(report.includes("Cards version: test-cards"), "report echoes the cards version");
assert(report.includes("Overall: review"), "report states the overall status");
assert(
  report.includes("Claude Code") && report.includes("--include-hook-events"),
  "report's review section names the drifted provider and marker",
);
assert(report.includes("Antigravity CLI"), "report's missing section names the absent provider");
assert(report.includes("Codex CLI"), "report's ready section names the verified provider");

const dashboard = buildProviderCapabilityDashboard(summary);
assert.equal(dashboard.basicStatus, "review", "dashboard basic status mirrors summarized drift");
assert(
  dashboard.basicRows.some((row) => row.providerId === "codex-cli" && row.status === "ready" && row.detail.includes("codex-cli 1.2.3")),
  "dashboard basic rows expose concise ready provider state",
);
assert(
  dashboard.basicRows.some((row) => row.providerId === "claude-code" && row.status === "review" && row.detail.includes("update bundled cards")),
  "dashboard basic rows expose concise review guidance",
);
assert(
  dashboard.advancedRows.some((row) => row.providerId === "claude-code" && row.missingMarkers.includes("--include-hook-events")),
  "dashboard advanced rows expose missing markers for agents",
);
assert(
  dashboard.agentInstruction.includes("Do not auto-route") &&
    dashboard.agentInstruction.includes("provider_adapters") &&
    dashboard.agentInstruction.includes("model_instruction_cards"),
  "dashboard includes compact agent instruction text",
);

const probe = (
  id: ProviderCapabilityProbe["id"],
  status: ProviderCapabilityProbe["status"],
): ProviderCapabilityProbe => ({
  id,
  displayName: id,
  cardIds: [id],
  status,
  binaries: [],
});
const synthetic = (probes: ProviderCapabilityProbe[]): ProviderCapabilitySnapshot => ({
  schemaVersion: "shellx-provider-capabilities.v1",
  generatedAt: "2026-06-03T00:00:00.000Z",
  cardsVersion: "synthetic",
  timeoutMs: 8000,
  providers: probes,
});

assert.equal(
  summarizeProviderCapabilities(synthetic([probe("grok", "ready"), probe("codex-cli", "ready")]))
    .overallStatus,
  "ready",
  "all ready -> ready",
);
assert.equal(
  summarizeProviderCapabilities(synthetic([probe("grok", "ready"), probe("codex-cli", "missing")]))
    .overallStatus,
  "incomplete",
  "missing without review -> incomplete",
);
assert.equal(
  summarizeProviderCapabilities(
    synthetic([probe("grok", "review"), probe("codex-cli", "missing")]),
  ).overallStatus,
  "review",
  "review outranks missing",
);

console.log("test-provider-capability-snapshot ok");
