import { chmodSync, existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import {
  clickReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElementAtFraction,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { releaseSurfaceProfileLaunchRootFromDebugTokenPath } from "../lib/release-surface-run-profile";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type AgentCliSetupAction =
  | { kind: "close"; via: "backdrop" | "button" }
  | { kind: "external-docs"; stage: "cards" | "confirmation" }
  | { kind: "open"; control: string; providerId: string | null }
  | { kind: "freshness"; surface: "status" | "setup" }
  | { kind: "install"; stage: "prepare" | "cancel" | "run" };

const DIALOG = "[data-debug-id='agent-cli-setup-dialog']";
const ASSISTANT = "[data-debug-id='agent-cli-setup-assistant']";
const CLOSE = `${ASSISTANT} .agent-cli-setup-header-actions button:last-child`;
const RECHECK = `${ASSISTANT} .agent-cli-setup-header-actions button:first-child`;
const REFRESH = ".provider-runner-actions button:last-child";
const STATUS_GROK = ".provider-adapter-row[data-agent-cli-provider='grok']";
const SETUP_GROK = ".agent-cli-setup-card[data-agent-cli-provider='grok']";
const INSTALL = "[data-debug-id='surface-components-agentclisetupassistant-5']";
const CONFIRMATION = "[data-debug-id='agent-cli-setup-confirm']";
const CANCEL_INSTALL = ".agent-cli-setup-confirm-actions button:first-child";
const RUN_INSTALLER = "[data-debug-id='surface-components-agentclisetupassistant-9']";
const CARD_OPEN_DOCS = ".agent-cli-setup-card[data-agent-cli-provider='grok'] .agent-cli-setup-card-actions button:first-child";
const CONFIRMATION_OPEN_DOCS = ".agent-cli-setup-confirm-links button:first-child";
const OWNED_DOCS_URL = "https://example.invalid/shellx-agent-cli-setup";
const OWNED_NPM_COMMAND = "npm install -g @openai/codex";
const OWNED_NPM_RECEIPT_NAME = "release-agent-cli-install-receipt.json";
const PROVIDERS = ["grok", "claude-code", "codex-cli", "antigravity-cli"] as const;
const configs = new Map<string, AgentCliSetupAction>([
  ['ui-control:src/components/AgentCliSetupAssistant.tsx:[data-debug-id="agent-cli-setup-dialog"]@src/components/AgentCliSetupAssistant.tsx#10', { kind: "close", via: "backdrop" }],
  ['ui-control:src/components/AgentCliSetupAssistant.tsx:role=button;name="Close"@src/components/AgentCliSetupAssistant.tsx#2', { kind: "close", via: "button" }],
  ...PROVIDERS.map((providerId): [string, AgentCliSetupAction] => [
    `ui-control:src/components/AgentCliStatusCard.tsx:[data-debug-id="agent-cli-setup-open-${providerId}"]@src/components/AgentCliStatusCard.tsx#1`,
    { kind: "open", control: `[data-debug-id='agent-cli-setup-open-${providerId}']`, providerId },
  ]),
  ['ui-control:src/components/AgentCliStatusCard.tsx:[data-debug-id="agent-cli-setup-open-missing"]@src/components/AgentCliStatusCard.tsx#2', {
    kind: "open",
    control: "[data-debug-id='agent-cli-setup-open-missing']",
    providerId: null,
  }],
  ['ui-control:src/components/AgentCliStatusCard.tsx:role=button;name="Refresh"@src/components/AgentCliStatusCard.tsx#3', {
    kind: "freshness",
    surface: "status",
  }],
  ['ui-control:src/components/AgentCliSetupAssistant.tsx:role=button;name="Recheck"@src/components/AgentCliSetupAssistant.tsx#1', {
    kind: "freshness",
    surface: "setup",
  }],
  ['ui-control:src/components/AgentCliSetupAssistant.tsx:role=button;name="Open docs"@src/components/AgentCliSetupAssistant.tsx#3', {
    kind: "external-docs",
    stage: "cards",
  }],
  ['ui-control:src/components/AgentCliSetupAssistant.tsx:role=button;name="Open docs"@src/components/AgentCliSetupAssistant.tsx#6', {
    kind: "external-docs",
    stage: "confirmation",
  }],
  ['ui-control:src/components/AgentCliSetupAssistant.tsx:[data-debug-id="surface-components-agentclisetupassistant-5"]@src/components/AgentCliSetupAssistant.tsx#5', {
    kind: "install",
    stage: "prepare",
  }],
  ['ui-control:src/components/AgentCliSetupAssistant.tsx:role=button;name="Cancel"@src/components/AgentCliSetupAssistant.tsx#8', {
    kind: "install",
    stage: "cancel",
  }],
  ['ui-control:src/components/AgentCliSetupAssistant.tsx:[data-debug-id="surface-components-agentclisetupassistant-9"]@src/components/AgentCliSetupAssistant.tsx#9', {
    kind: "install",
    stage: "run",
  }],
]);

export const AGENT_CLI_SETUP_LIFECYCLE_FIXTURES = [
  "ui:agent-cli-setup-owned-dialog-open",
  "ui:agent-cli-status-owned-setup-open",
  "ui:agent-cli-owned-target-live-refresh",
  "ui:agent-cli-owned-npm-install-lifecycle",
  "ui:agent-cli-owned-doc-link-cards",
  "ui:agent-cli-owned-doc-link-confirmation",
] as const;
export const AGENT_CLI_SETUP_LIFECYCLE_CLEANUPS = [
  "ui:close-agent-cli-setup-owned-dialog",
  "ui:close-agent-cli-status-dialog-and-restore-right-rail",
  "ui:close-agent-cli-live-scan-delete-owned-binary-restore-right-rail",
  "ui:cancel-agent-cli-preparation-close-dialog-delete-owned-shim-and-receipt",
] as const;
export const AGENT_CLI_SETUP_LIFECYCLE_ORACLES = [
  "ui:activation:agent-cli-setup-dialog-closed",
  "ui:activation:agent-cli-status-setup-dialog-opened",
  "ui:activation:agent-cli-fresh-version-observed",
  "ui:activation:agent-cli-owned-npm-confirmation-prepared",
  "ui:activation:agent-cli-owned-npm-confirmation-cancelled",
  "ui:activation:agent-cli-owned-npm-shim-receipt",
  "ui:activation:agent-cli-doc-link-dispatched",
] as const;

export function supportsAgentCliSetupLifecycleControl(assignment: Assignment): boolean {
  return configs.has(assignment.surface.id);
}

export async function exerciseAgentCliSetupLifecycleControl(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
  request: Pick<ReleaseSurfaceDriverRequest, "platform" | "runtime">,
): Promise<ReleaseSurfaceDriverOutcome> {
  const action = configs.get(assignment.surface.id);
  if (action?.kind === "freshness") {
    return exerciseAgentCliFreshness(connection, installedInput, assignment, request, action.surface);
  }
  if (action?.kind === "install") {
    return exerciseAgentCliInstallLifecycle(connection, installedInput, assignment, request, action.stage);
  }
  if (action?.kind === "external-docs") {
    return exerciseAgentCliExternalDocs(connection, installedInput, assignment, action.stage);
  }
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No renderer-owned Agent CLI setup close transition was observed.",
  };
  let baselineRightTab: string | null = null;
  try {
    const expectedFixture = action?.kind === "open"
      ? AGENT_CLI_SETUP_LIFECYCLE_FIXTURES[1]
      : AGENT_CLI_SETUP_LIFECYCLE_FIXTURES[0];
    if (!action || assignment.fixtureId !== expectedFixture) {
      throw new Error(`Agent CLI setup lifecycle fixture does not match ${assignment.surface.id}`);
    }
    if (action.kind === "open") {
      const baseline = await getUi(connection);
      baselineRightTab = typeof baseline.rightTab === "string" ? baseline.rightTab : null;
      if (!baselineRightTab) throw new Error("Agent CLI status fixture omitted the original right rail");
      await postUi(connection, {
        rightTab: "Tooling",
        agentCliSetupFixture: "status-card",
        source: "final-surface-agent-cli-status-card",
      });
      const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, action.control);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(installedInput, control);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceInstalledInputElement(installedInput, DIALOG);
      await waitForReleaseSurfaceInstalledInputElement(installedInput, ASSISTANT);
      if (action.providerId) {
        await waitForReleaseSurfaceInstalledInputElement(installedInput, providerCard(action.providerId));
        for (const providerId of PROVIDERS) {
          if (providerId !== action.providerId) {
            await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, providerCard(providerId));
          }
        }
      } else {
        for (const providerId of PROVIDERS) {
          await waitForReleaseSurfaceInstalledInputElement(installedInput, providerCard(providerId));
        }
      }
      outcome.effect = "pass";
      outcome.observedEffect = action.providerId
        ? `Native installed input opened the inert synthetic Agent CLI setup dialog filtered to exactly ${action.providerId}; no live scan, provider, installer, Vault, clipboard, or external action ran.`
        : "Native installed input opened the inert synthetic missing-Agent-CLI setup dialog with all four exact provider cards; no live scan, provider, installer, Vault, clipboard, or external action ran.";
      return outcome;
    }
    await postUi(connection, {
      agentCliSetupFixture: "cards",
      source: "final-surface-agent-cli-setup",
    });
    const dialog = await waitForReleaseSurfaceInstalledInputElement(installedInput, DIALOG);
    await waitForReleaseSurfaceInstalledInputElement(installedInput, ASSISTANT);
    outcome.present = "pass";

    if (action.via === "backdrop") {
      await clickReleaseSurfaceInstalledInputElementAtFraction(installedInput, dialog, 0.015, 0.015);
    } else {
      const close = await waitForReleaseSurfaceInstalledInputElement(
        installedInput,
        CLOSE,
      );
      await clickReleaseSurfaceInstalledInputElement(installedInput, close);
    }
    outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DIALOG);
    outcome.effect = "pass";
    outcome.observedEffect = "Bounded native input closed the synthetic Agent CLI setup dialog without invoking its disabled external or provider actions.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      if (await findReleaseSurfaceInstalledInputElement(installedInput, DIALOG)) {
        const close = await waitForReleaseSurfaceInstalledInputElement(installedInput, CLOSE);
        await clickReleaseSurfaceInstalledInputElement(installedInput, close);
        await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DIALOG);
      }
      await postUi(connection, {
        agentCliSetupFixture: "closed",
        ...(baselineRightTab ? { rightTab: baselineRightTab } : {}),
        source: "final-surface-agent-cli-setup-cleanup",
      });
      await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DIALOG);
      if (baselineRightTab) {
        const restored = await getUi(connection);
        if (restored.rightTab !== baselineRightTab || restored.agentCliSetupFixture !== "closed") {
          throw new Error("Agent CLI status cleanup did not restore the exact right rail and fixture baseline");
        }
      }
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Agent CLI setup lifecycle did not satisfy every required verdict";
  }
  return outcome;
}

async function exerciseAgentCliExternalDocs(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
  stage: "cards" | "confirmation",
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No isolated Agent CLI documentation handoff was observed.",
  };
  const expectedFixture = stage === "cards"
    ? "ui:agent-cli-owned-doc-link-cards"
    : "ui:agent-cli-owned-doc-link-confirmation";
  const controlSelector = stage === "cards" ? CARD_OPEN_DOCS : CONFIRMATION_OPEN_DOCS;
  try {
    if (assignment.fixtureId !== expectedFixture) {
      throw new Error(`Agent CLI documentation fixture does not match ${assignment.surface.id}`);
    }
    const baseline = await readExternalUrlDispatches(connection);
    await postUi(connection, {
      agentCliSetupFixture: stage,
      source: "final-surface-agent-cli-owned-doc-link",
    });
    const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, controlSelector);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(installedInput, control);
    outcome.invoke = "pass";
    const observed = await waitForExternalUrl(connection, baseline.length, OWNED_DOCS_URL);
    if (observed.length !== baseline.length + 1) {
      throw new Error("Agent CLI documentation handoff emitted more than one URL");
    }
    outcome.effect = "pass";
    outcome.observedEffect = `Native installed input dispatched ${OWNED_DOCS_URL} from the synthetic ${stage} fixture through the isolated external-browser handoff without launching an operator browser.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await postUi(connection, {
        agentCliSetupFixture: "closed",
        source: "final-surface-agent-cli-owned-doc-link-cleanup",
      });
      await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DIALOG);
      const restored = await getUi(connection);
      if (restored.agentCliSetupFixture !== "closed") {
        throw new Error("Agent CLI documentation cleanup did not close the exact fixture");
      }
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Agent CLI documentation handoff did not satisfy every required verdict";
  }
  return outcome;
}

async function readExternalUrlDispatches(connection: Connection): Promise<string[]> {
  const response = await fetch(`${connection.base}/events/recent?limit=64`, {
    headers: { Authorization: `Bearer ${connection.token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`GET /events/recent failed ${response.status}: ${(await response.text()).slice(0, 800)}`);
  const events = await response.json() as unknown;
  if (!Array.isArray(events)) throw new Error("recent event response is not an array");
  return events.flatMap((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return [];
    const row = event as { kind?: unknown; payload?: unknown };
    if (row.kind !== "external-url-dispatched" || !row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) return [];
    const url = (row.payload as { url?: unknown }).url;
    return typeof url === "string" ? [url] : [];
  });
}

async function waitForExternalUrl(
  connection: Connection,
  baselineLength: number,
  expectedUrl: string,
): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const urls = await readExternalUrlDispatches(connection);
    if (urls.length > baselineLength && urls.at(-1) === expectedUrl) return urls;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Agent CLI documentation handoff did not emit ${expectedUrl}`);
}

async function exerciseAgentCliFreshness(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
  request: Pick<ReleaseSurfaceDriverRequest, "platform" | "runtime">,
  surface: "status" | "setup",
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No fresh owned Agent CLI version transition was observed.",
  };
  const expectedFixture = "ui:agent-cli-owned-target-live-refresh";
  const expectedCleanup = "ui:close-agent-cli-live-scan-delete-owned-binary-restore-right-rail";
  const baseline = await getUi(connection);
  const baselineRightTab = typeof baseline.rightTab === "string" ? baseline.rightTab : null;
  let owned: OwnedAgentCliBinary | null = null;
  try {
    if (assignment.fixtureId !== expectedFixture || assignment.cleanupId !== expectedCleanup) {
      throw new Error(`Agent CLI freshness assignment does not match ${assignment.surface.id}`);
    }
    if (!baselineRightTab) throw new Error("Agent CLI freshness fixture omitted the right-rail baseline");
    owned = prepareOwnedAgentCliBinary(request, "shellx-refresh-1.0.0");
    await postUi(connection, {
      agentCliSetupFixture: surface === "status" ? "live-status" : "live-setup",
      ...(surface === "status" ? { rightTab: "Tooling" } : {}),
      source: "final-surface-agent-cli-live-refresh",
    });
    const receiptSelector = surface === "status" ? STATUS_GROK : SETUP_GROK;
    const controlSelector = surface === "status" ? REFRESH : RECHECK;
    await waitForVersionReceipt(installedInput, receiptSelector, "shellx-refresh-1.0.0");
    const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, controlSelector);
    outcome.present = "pass";
    writeOwnedAgentCliVersion(owned, request.platform, "shellx-refresh-2.0.0");
    await clickReleaseSurfaceInstalledInputElement(installedInput, control);
    outcome.invoke = "pass";
    const receipt = await waitForVersionReceipt(installedInput, receiptSelector, "shellx-refresh-2.0.0");
    if (receipt.includes("shellx-refresh-1.0.0")) {
      throw new Error("Agent CLI refresh retained the prior version receipt");
    }
    outcome.effect = "pass";
    outcome.observedEffect = `Native ${surface === "status" ? "Refresh" : "Recheck"} observed the replaced owned CLI version through the real local target resolution, --version, SHA-256, and size scan before any provider launch.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    try {
      await postUi(connection, {
        agentCliSetupFixture: "closed",
        ...(baselineRightTab ? { rightTab: baselineRightTab } : {}),
        source: "final-surface-agent-cli-live-refresh-cleanup",
      });
      await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, STATUS_GROK);
      await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, SETUP_GROK);
    } catch (error) {
      cleanupErrors.push(`renderer: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (owned) {
      try { cleanupOwnedAgentCliBinary(owned); }
      catch (error) { cleanupErrors.push(`binary: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try {
      const restored = await getUi(connection);
      if (baselineRightTab && restored.rightTab !== baselineRightTab) {
        throw new Error("Agent CLI freshness cleanup did not restore the exact right rail");
      }
    } catch (error) {
      cleanupErrors.push(`baseline: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else outcome.error = outcome.error
      ? `${outcome.error}; cleanup: ${cleanupErrors.join("; ")}`
      : `cleanup: ${cleanupErrors.join("; ")}`;
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Agent CLI freshness lifecycle did not satisfy every required verdict";
  }
  return outcome;
}

type OwnedNpmInstallFixture = {
  shimPath: string;
  receiptPath: string;
  binDir: string;
  localDir: string;
  removeBinDir: boolean;
  removeLocalDir: boolean;
};

type OwnedNpmReceipt = {
  schema: "shellx/release-agent-cli-install-receipt@1";
  providerId: "codex-cli";
  methodId: "npm";
  argv: ["install", "-g", "@openai/codex"];
};

async function exerciseAgentCliInstallLifecycle(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
  request: Pick<ReleaseSurfaceDriverRequest, "platform" | "runtime">,
  stage: "prepare" | "cancel" | "run",
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No owned Agent CLI npm install lifecycle was observed.",
  };
  const expectedFixture = "ui:agent-cli-owned-npm-install-lifecycle";
  const expectedCleanup = "ui:cancel-agent-cli-preparation-close-dialog-delete-owned-shim-and-receipt";
  const baseline = await getUi(connection);
  const baselineRightTab = typeof baseline.rightTab === "string" ? baseline.rightTab : null;
  let owned: OwnedNpmInstallFixture | null = null;
  let confirmationId: string | null = null;
  try {
    if (assignment.fixtureId !== expectedFixture || assignment.cleanupId !== expectedCleanup) {
      throw new Error(`Agent CLI install assignment does not match ${assignment.surface.id}`);
    }
    if (!baselineRightTab) throw new Error("Agent CLI install fixture omitted the right-rail baseline");
    owned = prepareOwnedNpmInstallFixture(request);
    await postUi(connection, {
      agentCliSetupFixture: "install-lifecycle",
      source: "final-surface-agent-cli-owned-npm-install",
    });
    const install = await waitForReleaseSurfaceInstalledInputElement(installedInput, INSTALL);
    if (stage === "prepare") outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(installedInput, install);
    if (stage === "prepare") outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElement(installedInput, CONFIRMATION);
    const confirmationReceipt = await observeReleaseSurfaceInstalledInputElement(
      installedInput,
      CONFIRMATION,
      ["title"],
    );
    confirmationId = exactOwnedConfirmationId(confirmationReceipt.title);

    if (stage === "prepare") {
      if (existsSync(owned.receiptPath)) throw new Error("npm shim executed during preparation");
      outcome.effect = "pass";
      outcome.observedEffect = `Native Install prepared ${OWNED_NPM_COMMAND} under exact confirmation ${confirmationId} through the production registry without executing the owned shim.`;
    } else if (stage === "cancel") {
      const cancel = await waitForReleaseSurfaceInstalledInputElement(installedInput, CANCEL_INSTALL);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(installedInput, cancel);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, CONFIRMATION);
      const replay = await postAgentCliInstall(connection, "confirm", confirmationId);
      if (replay.ok || !replay.text.includes("unknown or expired confirmation")) {
        throw new Error("cancelled Agent CLI confirmation remained executable");
      }
      confirmationId = null;
      if (existsSync(owned.receiptPath)) throw new Error("npm shim executed during cancellation");
      outcome.effect = "pass";
      outcome.observedEffect = "Native Cancel removed the exact production Codex npm confirmation; a direct replay was rejected as unknown or expired and the owned shim never ran.";
    } else {
      const run = await waitForReleaseSurfaceInstalledInputElement(installedInput, RUN_INSTALLER);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(installedInput, run);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, CONFIRMATION);
      const receipt = await waitForOwnedNpmReceipt(owned.receiptPath);
      assertOwnedNpmReceipt(receipt);
      confirmationId = null;
      outcome.effect = "pass";
      outcome.observedEffect = "Native Run installer consumed the exact production confirmation and executed only the fixed candidate-owned npm shim, which recorded argv install -g @openai/codex without an operator install or network access.";
    }
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (confirmationId) {
      try {
        const cancelled = await postAgentCliInstall(connection, "cancel", confirmationId);
        if (!cancelled.ok) throw new Error(cancelled.text);
        confirmationId = null;
      } catch (error) {
        cleanupErrors.push(`confirmation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      await postUi(connection, {
        agentCliSetupFixture: "closed",
        ...(baselineRightTab ? { rightTab: baselineRightTab } : {}),
        source: "final-surface-agent-cli-owned-npm-install-cleanup",
      });
      await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DIALOG);
    } catch (error) {
      cleanupErrors.push(`renderer: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (owned) {
      try { cleanupOwnedNpmInstallFixture(owned); }
      catch (error) { cleanupErrors.push(`owned files: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try {
      const restored = await getUi(connection);
      if (baselineRightTab && restored.rightTab !== baselineRightTab) {
        throw new Error("Agent CLI install cleanup did not restore the exact right rail");
      }
      if (restored.agentCliSetupFixture !== "closed") {
        throw new Error("Agent CLI install cleanup did not close the exact fixture");
      }
    } catch (error) {
      cleanupErrors.push(`baseline: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else outcome.error = outcome.error
      ? `${outcome.error}; cleanup: ${cleanupErrors.join("; ")}`
      : `cleanup: ${cleanupErrors.join("; ")}`;
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Agent CLI owned npm install lifecycle did not satisfy every required verdict";
  }
  return outcome;
}

function prepareOwnedNpmInstallFixture(
  request: Pick<ReleaseSurfaceDriverRequest, "platform" | "runtime">,
): OwnedNpmInstallFixture {
  const launchRoot = releaseSurfaceProfileLaunchRootFromDebugTokenPath(
    request.runtime.debugTokenPath,
    request.platform,
  );
  if (!/^shellx-final-webdriver-[a-f0-9]{16,64}$/.test(basename(launchRoot.replaceAll("\\", "/")))) {
    throw new Error("Agent CLI npm fixture is outside the exact disposable release profile");
  }
  const tokenNodePath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const profileRoot = dirname(dirname(tokenNodePath));
  const localDir = join(profileRoot, ".local");
  const binDir = join(localDir, "bin");
  const removeLocalDir = !existsSync(localDir);
  const removeBinDir = !existsSync(binDir);
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const shimPath = join(binDir, request.platform === "windows-installed" ? "npm.CMD" : "npm");
  const receiptPath = join(profileRoot, ".shellx", OWNED_NPM_RECEIPT_NAME);
  if (existsSync(shimPath) || existsSync(receiptPath)) {
    throw new Error("owned npm shim or receipt already exists");
  }
  const receipt = JSON.stringify({
    schema: "shellx/release-agent-cli-install-receipt@1",
    providerId: "codex-cli",
    methodId: "npm",
    argv: ["install", "-g", "@openai/codex"],
  } satisfies OwnedNpmReceipt);
  const content = request.platform === "windows-installed"
    ? [
        "@echo off",
        "setlocal",
        "if not \"%~1\"==\"install\" exit /b 64",
        "if not \"%~2\"==\"-g\" exit /b 64",
        "if not \"%~3\"==\"@openai/codex\" exit /b 64",
        "if not \"%~4\"==\"\" exit /b 64",
        `if exist \"%USERPROFILE%\\.shellx\\${OWNED_NPM_RECEIPT_NAME}\" exit /b 75`,
        `>\"%USERPROFILE%\\.shellx\\${OWNED_NPM_RECEIPT_NAME}\" echo ${receipt}`,
        "echo SHELLX_OWNED_NPM_SHIM_OK",
        "exit /b 0",
        "",
      ].join("\r\n")
    : [
        "#!/bin/sh",
        "set -eu",
        "[ \"$#\" -eq 3 ]",
        "[ \"$1\" = install ]",
        "[ \"$2\" = -g ]",
        "[ \"$3\" = @openai/codex ]",
        `receipt=\"$HOME/.shellx/${OWNED_NPM_RECEIPT_NAME}\"`,
        "[ ! -e \"$receipt\" ]",
        "umask 077",
        `( set -C; printf '%s\\n' '${receipt}' > \"$receipt\" )`,
        "printf '%s\\n' SHELLX_OWNED_NPM_SHIM_OK",
        "",
      ].join("\n");
  writeFileSync(shimPath, content, { encoding: "utf8", flag: "wx", mode: 0o700 });
  if (request.platform !== "windows-installed") chmodSync(shimPath, 0o700);
  return { shimPath, receiptPath, binDir, localDir, removeBinDir, removeLocalDir };
}

function cleanupOwnedNpmInstallFixture(owned: OwnedNpmInstallFixture): void {
  if (existsSync(owned.receiptPath)) unlinkSync(owned.receiptPath);
  if (existsSync(owned.shimPath)) unlinkSync(owned.shimPath);
  if (owned.removeBinDir && existsSync(owned.binDir)) rmdirSync(owned.binDir);
  if (owned.removeLocalDir && existsSync(owned.localDir)) rmdirSync(owned.localDir);
  if (existsSync(owned.receiptPath) || existsSync(owned.shimPath)) {
    throw new Error("owned npm shim or receipt remained after cleanup");
  }
}

function exactOwnedConfirmationId(title: unknown): string {
  if (typeof title !== "string"
    || !title.includes("Agent CLI install confirmation receipt")
    || !title.includes("provider=codex-cli")
    || !title.includes("method=npm")
    || !title.includes(`command=${OWNED_NPM_COMMAND}`)) {
    throw new Error("Agent CLI confirmation omitted the exact Codex npm receipt");
  }
  const id = title.match(/(?:^| · )id=(setup-[0-9a-f-]{20,80})(?: · |$)/)?.[1];
  if (!id) throw new Error("Agent CLI confirmation omitted a bounded production confirmation id");
  return id;
}

async function postAgentCliInstall(
  connection: Connection,
  action: "cancel" | "confirm",
  confirmationId: string,
): Promise<{ ok: boolean; text: string }> {
  const response = await fetch(`${connection.base}/agent_cli_setup/install/${action}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ confirmationId }),
    signal: AbortSignal.timeout(5_000),
  });
  return { ok: response.ok, text: await response.text() };
}

async function waitForOwnedNpmReceipt(path: string): Promise<OwnedNpmReceipt> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as OwnedNpmReceipt;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("owned npm shim receipt did not appear");
}

function assertOwnedNpmReceipt(receipt: OwnedNpmReceipt): void {
  if (receipt.schema !== "shellx/release-agent-cli-install-receipt@1"
    || receipt.providerId !== "codex-cli"
    || receipt.methodId !== "npm"
    || JSON.stringify(receipt.argv) !== JSON.stringify(["install", "-g", "@openai/codex"])) {
    throw new Error("owned npm shim wrote the wrong immutable receipt");
  }
}

function nodeReadablePath(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) {
    return resolve(path);
  }
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("unable to map the Agent CLI setup profile path");
  }
  return resolve(result.stdout.trim());
}

type OwnedAgentCliBinary = {
  path: string;
  binDir: string;
  localDir: string;
  removeBinDir: boolean;
  removeLocalDir: boolean;
};

function prepareOwnedAgentCliBinary(
  request: Pick<ReleaseSurfaceDriverRequest, "platform" | "runtime">,
  version: string,
): OwnedAgentCliBinary {
  const profileRoot = releaseSurfaceProfileLaunchRootFromDebugTokenPath(
    request.runtime.debugTokenPath,
    request.platform,
  );
  if (!/^shellx-final-webdriver-[a-f0-9]{16,64}$/.test(basename(profileRoot.replaceAll("\\", "/")))) {
    throw new Error("Agent CLI freshness fixture is outside the exact disposable release profile");
  }
  const localDir = join(profileRoot, ".local");
  const binDir = join(localDir, "bin");
  const removeLocalDir = !existsSync(localDir);
  const removeBinDir = !existsSync(binDir);
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const path = join(binDir, request.platform === "windows-installed" ? "grok.CMD" : "grok");
  if (existsSync(path)) throw new Error("owned Agent CLI binary target already exists");
  const owned = { path, binDir, localDir, removeBinDir, removeLocalDir };
  writeOwnedAgentCliVersion(owned, request.platform, version, true);
  return owned;
}

function writeOwnedAgentCliVersion(
  owned: OwnedAgentCliBinary,
  platform: ReleaseSurfaceDriverRequest["platform"],
  version: string,
  createOnly = false,
): void {
  if (!/^shellx-refresh-[12]\.0\.0$/.test(version)) throw new Error("owned Agent CLI version is invalid");
  const content = platform === "windows-installed"
    ? `@echo off\r\nif "%~1"=="--version" (\r\n  echo grok ${version}\r\n  exit /b 0\r\n)\r\nexit /b 64\r\n`
    : `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf '%s\\n' 'grok ${version}'\n  exit 0\nfi\nexit 64\n`;
  writeFileSync(owned.path, content, { encoding: "utf8", flag: createOnly ? "wx" : "w", mode: 0o700 });
  if (platform !== "windows-installed") chmodSync(owned.path, 0o700);
}

function cleanupOwnedAgentCliBinary(owned: OwnedAgentCliBinary): void {
  if (existsSync(owned.path)) unlinkSync(owned.path);
  if (owned.removeBinDir && existsSync(owned.binDir)) rmdirSync(owned.binDir);
  if (owned.removeLocalDir && existsSync(owned.localDir)) rmdirSync(owned.localDir);
}

async function waitForVersionReceipt(
  installedInput: ReleaseSurfaceInstalledInputSession,
  selector: string,
  version: string,
): Promise<string> {
  await waitForReleaseSurfaceInstalledInputElement(installedInput, selector);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const observed = await observeReleaseSurfaceInstalledInputElement(installedInput, selector, ["title"]);
    if (typeof observed.title === "string" && observed.title.includes(version)) return observed.title;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Agent CLI scan did not expose exact version ${version}`);
}

function providerCard(providerId: string): string {
  return `.agent-cli-setup-card[data-agent-cli-provider='${providerId}']`;
}

async function getUi(connection: Connection): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}/state/ui`, {
    headers: { Authorization: `Bearer ${connection.token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`GET /state/ui failed ${response.status}: ${(await response.text()).slice(0, 800)}`);
  const value = await response.json() as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GET /state/ui returned a non-object");
  return value as Record<string, unknown>;
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${connection.base}/state/ui`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`POST /state/ui failed ${response.status}: ${(await response.text()).slice(0, 800)}`);
  }
}
