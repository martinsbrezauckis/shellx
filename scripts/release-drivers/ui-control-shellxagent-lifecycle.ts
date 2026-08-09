import {
  clickReleaseSurfaceInstalledInputElement,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { postUi } from "./ui-control-work-preview-start";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };

const REVEAL_SURFACE = "src/components/settings/ShellxagentTab.tsx:[data-debug-id=\"surface-components-settings-shellxagenttab-1\"]";
const REGENERATE_SURFACE = "src/components/settings/ShellxagentTab.tsx:[data-debug-id=\"surface-components-settings-shellxagenttab-3\"]";
const SETTINGS_DIALOG = "[role='dialog'][aria-label='Settings']";
const SETTINGS_TABS = ["general", "vault", "connections", "connectors", "desktop", "shellxagent", "data", "about"] as const;
const SETTINGS_SHELLXAGENT = "[data-debug-id='settings-tab-shellxagent']";
const REVEAL = "[data-debug-id='surface-components-settings-shellxagenttab-1']";
const COPY = "[data-debug-id='surface-components-settings-shellxagenttab-2']";
const REGENERATE = "[data-debug-id='surface-components-settings-shellxagenttab-3']";

export const SHELLXAGENT_LIFECYCLE_FIXTURES = [
  "ui:shellxagent-owned-safe-token",
  "ui:shellxagent-isolated-token-rotation",
] as const;
export const SHELLXAGENT_LIFECYCLE_CLEANUPS = [
  "ui:hide-owned-shellxagent-token-close-settings-and-clear-fixture",
  "ui:restore-isolated-shellxagent-token-mode-and-settings",
] as const;
export const SHELLXAGENT_LIFECYCLE_ORACLES = ["ui:activation:shellxagent-token-file-rotated"] as const;

export function supportsShellxagentLifecycleControl(assignment: Assignment): boolean {
  return assignment.surface.name === REVEAL_SURFACE || assignment.surface.name === REGENERATE_SURFACE;
}

export async function exerciseShellxagentLifecycleControl(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
  request?: Pick<ReleaseSurfaceDriverRequest, "runtime">,
): Promise<ReleaseSurfaceDriverOutcome> {
  if (assignment.surface.name === REGENERATE_SURFACE) {
    if (!request) throw new Error("ShellX Agent token rotation requires the attested runtime binding");
    return exerciseShellxagentTokenRotation(connection, installedInput, assignment, request);
  }
  const outcome = emptyOutcome(assignment);
  let fixtureStarted = false;
  try {
    if (await findReleaseSurfaceInstalledInputElement(installedInput, SETTINGS_DIALOG)) {
      throw new Error("ShellX Agent lifecycle refuses to overlay an operator Settings dialog");
    }
    fixtureStarted = true;
    await postUi(connection, {
      debugShellxagentFixture: "owned-safe",
      openModal: "settings",
      source: "final-surface-owned-shellxagent-token",
    });

    const reveal = await waitForReleaseSurfaceInstalledInputElement(installedInput, REVEAL, {
      timeoutMs: 8_000,
      pollMs: 75,
    });
    await expectPressed(installedInput, false);
    await expectDisabled(installedInput, COPY);
    await expectDisabled(installedInput, REGENERATE);
    outcome.present = "pass";

    await clickReleaseSurfaceInstalledInputElement(installedInput, reveal);
    outcome.invoke = "pass";
    await expectPressed(installedInput, true);
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click revealed only the fixed renderer-owned ShellX Agent token while Copy and Regenerate stayed disabled; no clipboard, credential file, provider, Vault, external navigation, or persisted Settings action was invoked.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    applyCleanup(outcome, fixtureStarted
      ? await cleanupFixture(connection, installedInput)
      : null);
  }
  return finalize(outcome);
}

async function exerciseShellxagentTokenRotation(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
  request: Pick<ReleaseSurfaceDriverRequest, "runtime">,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  const tokenPath = resolve(request.runtime.debugTokenPath);
  const original = readFileSync(tokenPath);
  const originalMode = statSync(tokenPath).mode & 0o777;
  const originalHash = sha256(original);
  let baselineTab: string | null = null;
  let tokenRestored = false;
  try {
    if (basename(tokenPath) !== "shellxagent.token" || basename(dirname(tokenPath)) !== ".shellx") {
      throw new Error("ShellX Agent rotation refused a token path outside an exact isolated .shellx profile");
    }
    if (!/^[0-9a-f]{32}$/.test(original.toString("utf8").trim())) {
      throw new Error("isolated ShellX Agent baseline token has an invalid shape");
    }
    if (await findReleaseSurfaceInstalledInputElement(installedInput, SETTINGS_DIALOG)) {
      throw new Error("ShellX Agent rotation refuses to overlay an operator Settings dialog");
    }
    await postUi(connection, { openModal: "settings", source: "final-surface-shellxagent-rotation" });
    await waitForReleaseSurfaceInstalledInputElement(installedInput, SETTINGS_DIALOG);
    baselineTab = await activeSettingsTab(installedInput);
    await clickSelector(installedInput, SETTINGS_SHELLXAGENT);
    await waitForReleaseSurfaceInstalledInputElement(installedInput, `${SETTINGS_SHELLXAGENT}[aria-selected='true']`);
    const regenerate = await waitForReleaseSurfaceInstalledInputElement(installedInput, REGENERATE);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(installedInput, regenerate);
    outcome.invoke = "pass";
    const rotated = await waitForRotatedToken(tokenPath, originalHash);
    if (rotated.length !== 32 || !/^[0-9a-f]{32}$/.test(rotated.toString("utf8"))) {
      throw new Error("rotated ShellX Agent token did not retain its exact 32-hex contract");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "Native input rotated the isolated ShellX Agent credential file to a different 32-hex SHA-256 identity; the original bytes and permissions were then restored without recording either token value.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const cleanupErrors: string[] = [];
    try {
      writeFileSync(tokenPath, original, { mode: originalMode });
      if (sha256(readFileSync(tokenPath)) !== originalHash || (statSync(tokenPath).mode & 0o777) !== originalMode) {
        throw new Error("isolated ShellX Agent token bytes or permissions were not restored exactly");
      }
      tokenRestored = true;
    } catch (error) {
      cleanupErrors.push(`token restore: ${errorText(error)}`);
    }
    if (tokenRestored) {
      try {
        const health = await fetch(`${connection.base}/health`, {
          headers: { Authorization: `Bearer ${connection.token}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (!health.ok) throw new Error(`restored Debug API authentication returned ${health.status}`);
        if (baselineTab) {
          await clickSelector(installedInput, `[data-debug-id='settings-tab-${baselineTab}']`);
          await waitForReleaseSurfaceInstalledInputElement(
            installedInput,
            `[data-debug-id='settings-tab-${baselineTab}'][aria-selected='true']`,
          );
        }
        await postUi(connection, { openModal: "close", source: "final-surface-shellxagent-rotation-cleanup" });
        await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, SETTINGS_DIALOG);
      } catch (error) {
        cleanupErrors.push(`view restore: ${errorText(error)}`);
      }
    }
    if (cleanupErrors.length === 0 && tokenRestored) outcome.cleanup = "pass";
    else if (cleanupErrors.length > 0) outcome.error = outcome.error
      ? `${outcome.error}; cleanup: ${cleanupErrors.join("; ")}`
      : `cleanup: ${cleanupErrors.join("; ")}`;
  }
  return finalize(outcome);
}

async function activeSettingsTab(installedInput: ReleaseSurfaceInstalledInputSession): Promise<string> {
  for (const tab of SETTINGS_TABS) {
    if (await findReleaseSurfaceInstalledInputElement(
      installedInput,
      `[data-debug-id='settings-tab-${tab}'][aria-selected='true']`,
    )) return tab;
  }
  throw new Error("Settings did not expose one exact active tab baseline");
}

async function clickSelector(installedInput: ReleaseSurfaceInstalledInputSession, selector: string): Promise<void> {
  await clickReleaseSurfaceInstalledInputElement(
    installedInput,
    await waitForReleaseSurfaceInstalledInputElement(installedInput, selector),
  );
}

async function waitForRotatedToken(path: string, originalHash: string): Promise<Buffer> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const current = readFileSync(path);
    if (sha256(current) !== originalHash) return Buffer.from(current.toString("utf8").trim(), "utf8");
    await delay(75);
  }
  throw new Error("ShellX Agent token file did not rotate before timeout");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function cleanupFixture(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
): Promise<string | null> {
  const errors: string[] = [];
  try {
    const reveal = await findReleaseSurfaceInstalledInputElement(installedInput, REVEAL);
    if (reveal) {
      const state = await observeReleaseSurfaceInstalledInputElement(installedInput, REVEAL, ["pressed"]);
      if (state.pressed === true) await clickReleaseSurfaceInstalledInputElement(installedInput, reveal);
      await expectPressed(installedInput, false);
    }
  } catch (error) {
    errors.push(`hide: ${errorText(error)}`);
  }
  try {
    await postUi(connection, {
      openModal: "close",
      debugShellxagentFixture: "clear",
      source: "final-surface-owned-shellxagent-cleanup",
    });
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, SETTINGS_DIALOG, {
      timeoutMs: 5_000,
      pollMs: 50,
    });
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, REVEAL, {
      timeoutMs: 5_000,
      pollMs: 50,
    });
  } catch (error) {
    errors.push(`fixture clear: ${errorText(error)}`);
  }
  return errors.length > 0 ? errors.join("; ") : null;
}

async function expectPressed(
  installedInput: ReleaseSurfaceInstalledInputSession,
  expected: boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(installedInput, REVEAL, ["pressed"]);
    if (state.present && state.visible && state.pressed === expected) return;
    await delay(50);
  }
  throw new Error(`owned ShellX Agent Reveal did not reach aria-pressed=${String(expected)}`);
}

async function expectDisabled(
  installedInput: ReleaseSurfaceInstalledInputSession,
  selector: string,
): Promise<void> {
  const state = await observeReleaseSurfaceInstalledInputElement(installedInput, selector, ["disabled"]);
  if (!state.present || !state.visible || state.disabled !== true) {
    throw new Error(`owned ShellX Agent fixture did not disable ${selector}`);
  }
}

function emptyOutcome(assignment: Assignment): ReleaseSurfaceDriverOutcome {
  return {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No reversible ShellX Agent token visibility transition was observed.",
  };
}

function applyCleanup(outcome: ReleaseSurfaceDriverOutcome, cleanupError: string | null): void {
  if (!cleanupError) outcome.cleanup = "pass";
  else outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanupError}` : `cleanup: ${cleanupError}`;
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "ShellX Agent control did not satisfy every safe lifecycle verdict";
  }
  return outcome;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
