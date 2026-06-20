export type ProviderProbeId = "grok" | "codex-cli" | "claude-code" | "antigravity-cli";

export interface ProviderProbeSpec {
  id: ProviderProbeId;
  displayName: string;
  cardIds: string[];
  binaryNames: string[];
  versionArgs: string[];
  helpProbes: ProviderHelpProbeSpec[];
}

export interface ProviderHelpProbeSpec {
  id: string;
  args: string[];
  markers: string[];
}

export interface CliProbeResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface ProviderCapabilitySnapshot {
  schemaVersion: "shellx-provider-capabilities.v1";
  generatedAt: string;
  cardsVersion?: string;
  timeoutMs: number;
  providers: ProviderCapabilityProbe[];
}

export interface ProviderCapabilityProbe {
  id: ProviderProbeId;
  displayName: string;
  cardIds: string[];
  status: "ready" | "missing" | "review";
  binaries: ProviderBinaryProbe[];
}

export interface ProviderBinaryProbe {
  name: string;
  available: boolean;
  version?: string;
  versionExitCode: number | null;
  versionTimedOut: boolean;
  versionError?: string;
  help: ProviderHelpProbe[];
}

export interface ProviderHelpProbe {
  id: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  markers: ProviderMarkerProbe[];
}

export interface ProviderMarkerProbe {
  marker: string;
  present: boolean;
}

export type CliProbeRunner = (
  binary: string,
  args: string[],
  timeoutMs: number,
) => Promise<CliProbeResult>;

export const PROVIDER_PROBE_SPECS: ProviderProbeSpec[] = [
  {
    id: "grok",
    displayName: "Grok",
    cardIds: ["grok-imagine-video", "grok-imagine-image"],
    binaryNames: ["grok"],
    versionArgs: ["--version"],
    helpProbes: [
      {
        id: "top-level",
        args: ["--help"],
        markers: ["agent", "mcp", "inspect", "trace", "--resume", "--continue"],
      },
      {
        id: "mcp",
        args: ["mcp", "--help"],
        markers: ["doctor"],
      },
    ],
  },
  {
    id: "codex-cli",
    displayName: "Codex CLI",
    cardIds: ["codex-cli", "codex-gpt-image"],
    binaryNames: ["codex"],
    versionArgs: ["--version"],
    helpProbes: [
      {
        id: "exec",
        args: ["exec", "--help"],
        markers: ["--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"],
      },
      {
        id: "resume",
        args: ["exec", "resume", "--help"],
        markers: ["--json"],
      },
    ],
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    cardIds: ["claude-code"],
    binaryNames: ["claude"],
    versionArgs: ["--version"],
    helpProbes: [
      {
        id: "print",
        args: ["-p", "--help"],
        markers: [
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--include-hook-events",
          "--permission-mode",
          "--mcp-config",
          "--resume",
        ],
      },
    ],
  },
  {
    id: "antigravity-cli",
    displayName: "Antigravity CLI",
    cardIds: ["antigravity-cli"],
    binaryNames: ["agy"],
    versionArgs: ["--version"],
    helpProbes: [
      {
        id: "print",
        args: ["--help"],
        markers: ["--print", "--add-dir", "--conversation", "--sandbox", "--dangerously-skip-permissions"],
      },
    ],
  },
];

export function detectMarkers(text: string, markers: string[]): ProviderMarkerProbe[] {
  const haystack = text.toLowerCase();
  return markers.map((marker) => ({
    marker,
    present: haystack.includes(marker.toLowerCase()),
  }));
}

export function firstNonEmptyLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

export function extractBundledCardsVersion(source: string): string | undefined {
  return /MODEL_INSTRUCTION_CARDS_VERSION:\s*&str\s*=\s*"([^"]+)"/.exec(source)?.[1];
}

export async function buildProviderCapabilitySnapshot(options: {
  runner: CliProbeRunner;
  timeoutMs?: number;
  generatedAt?: string;
  cardsVersion?: string;
  specs?: ProviderProbeSpec[];
}): Promise<ProviderCapabilitySnapshot> {
  const timeoutMs = clampTimeoutMs(options.timeoutMs);
  const providers = [];
  for (const spec of options.specs ?? PROVIDER_PROBE_SPECS) {
    providers.push(await probeProvider(spec, options.runner, timeoutMs));
  }
  return {
    schemaVersion: "shellx-provider-capabilities.v1",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    cardsVersion: options.cardsVersion,
    timeoutMs,
    providers,
  };
}

async function probeProvider(
  spec: ProviderProbeSpec,
  runner: CliProbeRunner,
  timeoutMs: number,
): Promise<ProviderCapabilityProbe> {
  const binaries: ProviderBinaryProbe[] = [];
  for (const name of spec.binaryNames) {
    binaries.push(await probeBinary(spec, name, runner, timeoutMs));
  }
  const anyAvailable = binaries.some((binary) => binary.available);
  const anyMissingMarker = binaries
    .filter((binary) => binary.available)
    .some((binary) => binary.help.some((help) => help.markers.some((marker) => !marker.present)));
  return {
    id: spec.id,
    displayName: spec.displayName,
    cardIds: spec.cardIds,
    status: !anyAvailable ? "missing" : anyMissingMarker ? "review" : "ready",
    binaries,
  };
}

async function probeBinary(
  spec: ProviderProbeSpec,
  name: string,
  runner: CliProbeRunner,
  timeoutMs: number,
): Promise<ProviderBinaryProbe> {
  const versionResult = await runner(name, spec.versionArgs, timeoutMs);
  const available = !versionResult.errorCode;
  const combinedVersion = `${versionResult.stdout}\n${versionResult.stderr}`;
  const help: ProviderHelpProbe[] = [];
  if (available) {
    for (const probe of spec.helpProbes) {
      const result = await runner(name, probe.args, timeoutMs);
      help.push({
        id: probe.id,
        args: probe.args,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        markers: detectMarkers(`${result.stdout}\n${result.stderr}`, probe.markers),
      });
    }
  }
  return {
    name,
    available,
    version: firstNonEmptyLine(combinedVersion),
    versionExitCode: versionResult.exitCode,
    versionTimedOut: versionResult.timedOut,
    versionError: versionResult.errorCode ?? versionResult.errorMessage,
    help,
  };
}

function clampTimeoutMs(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 8000;
  return Math.max(1000, Math.min(30000, Math.trunc(value ?? 8000)));
}

export interface ProviderCapabilityMissingMarker {
  binary: string;
  helpId: string;
  helpArgs: string[];
  marker: string;
}

export interface ProviderCapabilityFinding {
  id: ProviderProbeId;
  displayName: string;
  status: "ready" | "review" | "missing";
  cardIds: string[];
  version?: string;
  missingBinaries: string[];
  missingMarkers: ProviderCapabilityMissingMarker[];
  timedOutProbes: string[];
  recommendation: string;
}

export type ProviderCapabilityOverallStatus = "ready" | "review" | "incomplete";

export interface ProviderCapabilitySummary {
  schemaVersion: "shellx-provider-capabilities.v1";
  generatedAt: string;
  cardsVersion?: string;
  overallStatus: ProviderCapabilityOverallStatus;
  counts: { ready: number; review: number; missing: number };
  findings: ProviderCapabilityFinding[];
}

export interface ProviderCapabilityDashboardRow {
  providerId: ProviderProbeId;
  displayName: string;
  status: "ready" | "review" | "missing";
  detail: string;
}

export interface ProviderCapabilityDashboardAdvancedRow extends ProviderCapabilityDashboardRow {
  cardIds: string[];
  version?: string;
  missingBinaries: string[];
  missingMarkers: string[];
  timedOutProbes: string[];
  recommendation: string;
}

export interface ProviderCapabilityDashboard {
  schemaVersion: "shellx-provider-capabilities.v1";
  generatedAt: string;
  cardsVersion?: string;
  basicStatus: ProviderCapabilityOverallStatus;
  basicLabel: string;
  basicRows: ProviderCapabilityDashboardRow[];
  advancedRows: ProviderCapabilityDashboardAdvancedRow[];
  agentInstruction: string;
}

export function summarizeProviderCapabilities(
  snapshot: ProviderCapabilitySnapshot,
): ProviderCapabilitySummary {
  const findings = snapshot.providers.map(toFinding);
  const counts = {
    ready: findings.filter((finding) => finding.status === "ready").length,
    review: findings.filter((finding) => finding.status === "review").length,
    missing: findings.filter((finding) => finding.status === "missing").length,
  };
  const overallStatus: ProviderCapabilityOverallStatus =
    counts.review > 0 ? "review" : counts.missing > 0 ? "incomplete" : "ready";

  return {
    schemaVersion: snapshot.schemaVersion,
    generatedAt: snapshot.generatedAt,
    cardsVersion: snapshot.cardsVersion,
    overallStatus,
    counts,
    findings,
  };
}

export function buildProviderCapabilityDashboard(
  summary: ProviderCapabilitySummary,
): ProviderCapabilityDashboard {
  const advancedRows = summary.findings.map((finding) => ({
    providerId: finding.id,
    displayName: finding.displayName,
    status: finding.status,
    detail: conciseProviderDetail(finding),
    cardIds: finding.cardIds,
    version: finding.version,
    missingBinaries: finding.missingBinaries,
    missingMarkers: finding.missingMarkers.map((marker) => marker.marker),
    timedOutProbes: finding.timedOutProbes,
    recommendation: finding.recommendation,
  }));
  return {
    schemaVersion: summary.schemaVersion,
    generatedAt: summary.generatedAt,
    cardsVersion: summary.cardsVersion,
    basicStatus: summary.overallStatus,
    basicLabel: capabilityDashboardStatusLabel(summary.overallStatus),
    basicRows: advancedRows.map((row) => ({
      providerId: row.providerId,
      displayName: row.displayName,
      status: row.status,
      detail: row.detail,
    })),
    advancedRows,
    agentInstruction: [
      "Do not auto-route provider requests.",
      "Use model_instruction_cards for user-directed provider recipes.",
      "Use provider_adapters or provider capability snapshots to preflight CLI availability before handoff.",
      "If a provider is review/missing, report the exact drift and ask the user before choosing a fallback.",
    ].join(" "),
  };
}

function toFinding(probe: ProviderCapabilityProbe): ProviderCapabilityFinding {
  const missingBinaries = probe.binaries.filter((binary) => !binary.available).map((binary) => binary.name);
  const missingMarkers: ProviderCapabilityMissingMarker[] = [];
  const timedOutProbes: string[] = [];
  let version: string | undefined;

  for (const binary of probe.binaries) {
    if (!binary.available) continue;
    if (!version && binary.version) version = binary.version;

    for (const help of binary.help) {
      if (help.timedOut) timedOutProbes.push(`${binary.name} ${help.id}`);
      for (const marker of help.markers) {
        if (!marker.present) {
          missingMarkers.push({
            binary: binary.name,
            helpId: help.id,
            helpArgs: help.args,
            marker: marker.marker,
          });
        }
      }
    }
  }

  return {
    id: probe.id,
    displayName: probe.displayName,
    status: probe.status,
    cardIds: probe.cardIds,
    version,
    missingBinaries,
    missingMarkers,
    timedOutProbes,
    recommendation: recommendFor(probe, missingBinaries, missingMarkers, timedOutProbes),
  };
}

function recommendFor(
  probe: ProviderCapabilityProbe,
  missingBinaries: string[],
  missingMarkers: ProviderCapabilityMissingMarker[],
  timedOutProbes: string[],
): string {
  const cards = probe.cardIds.length > 0 ? probe.cardIds.join(", ") : "(no card)";

  if (probe.status === "missing") {
    const bins = missingBinaries.length > 0 ? missingBinaries.join(", ") : "binary";
    return `Not installed on this transport (${bins}). Run the snapshot where ${probe.displayName} exists before trusting card(s) ${cards}.`;
  }

  if (probe.status === "review") {
    const markers = missingMarkers.map((marker) => `${marker.marker} (${formatHelpInvocation(marker)})`).join("; ");
    const timeoutNote =
      timedOutProbes.length > 0 ? ` Help probe(s) timed out: ${timedOutProbes.join(", ")}.` : "";
    return `Installed CLI no longer advertises: ${markers}. Update bundled card(s) ${cards} or the probe spec, then re-run.${timeoutNote}`;
  }

  return `Bundled card(s) ${cards} verified against the installed CLI.`;
}

function conciseProviderDetail(finding: ProviderCapabilityFinding): string {
  if (finding.status === "ready") {
    return finding.version
      ? `${finding.version}; bundled cards verified.`
      : "Installed CLI advertises expected help markers; bundled cards verified.";
  }
  if (finding.status === "review") {
    const markers = finding.missingMarkers.map((marker) => marker.marker).join(", ");
    return `Help-surface drift: ${markers || "unknown marker"}; update bundled cards or probe spec.`;
  }
  return `Not installed on this transport: ${finding.missingBinaries.join(", ") || "binary"}.`;
}

function capabilityDashboardStatusLabel(status: ProviderCapabilityOverallStatus): string {
  switch (status) {
    case "ready":
      return "All probed provider CLIs match bundled cards.";
    case "review":
      return "One or more installed provider CLIs changed; review bundled cards before release.";
    case "incomplete":
    default:
      return "Some provider CLIs are missing on this transport.";
  }
}

function formatHelpInvocation(marker: ProviderCapabilityMissingMarker): string {
  return `${marker.binary} ${marker.helpArgs.join(" ")}`.trim();
}

export function renderProviderCapabilityReport(summary: ProviderCapabilitySummary): string {
  const review = summary.findings.filter((finding) => finding.status === "review");
  const missing = summary.findings.filter((finding) => finding.status === "missing");
  const ready = summary.findings.filter((finding) => finding.status === "ready");

  const reviewBody =
    review.length > 0
      ? review
          .map((finding) => `- ${finding.displayName} (${joinCards(finding.cardIds)}): ${finding.recommendation}`)
          .join("\n")
      : "- none";
  const missingBody =
    missing.length > 0
      ? missing
          .map(
            (finding) =>
              `- ${finding.displayName} (${joinCards(finding.cardIds)}): ${
                finding.missingBinaries.join(", ") || "binary"
              } not found.`,
          )
          .join("\n")
      : "- none";
  const readyBody =
    ready.length > 0
      ? ready
          .map((finding) => `- ${finding.displayName}${finding.version ? ` (${finding.version})` : ""}`)
          .join("\n")
      : "- none";

  return [
    "ShellX provider capability report",
    "",
    `Cards version: ${summary.cardsVersion ?? "unknown"}`,
    `Generated: ${summary.generatedAt}`,
    "",
    `Overall: ${summary.overallStatus}`,
    `Ready: ${summary.counts.ready}`,
    `Review: ${summary.counts.review}`,
    `Missing: ${summary.counts.missing}`,
    "",
    "Cards needing review (help-surface drift):",
    reviewBody,
    "",
    "Not installed on this transport:",
    missingBody,
    "",
    "Verified ready:",
    readyBody,
    "",
    "Note: review artifact only. Update bundled cards and probe specs from this",
    "evidence, then re-run. Do not auto-apply snapshot data into runtime policy.",
  ].join("\n");
}

function joinCards(cardIds: string[]): string {
  return cardIds.length > 0 ? cardIds.join(", ") : "no card";
}
