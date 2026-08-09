import type { RawEventFrame } from "../types/acp";
import {
  getProviderSessionState,
  startProviderSession,
  type ProviderSessionStartRequest,
} from "./provider-sessions";
import { apiGet } from "./debug-api";

export const DEBUG_PROVIDER_ACTION_FIXTURE_ID = "provider-action-lifecycle";

export const DEBUG_PROVIDER_ACTIONS = [
  "activity-ask-agent",
  "browser-explain-page",
  "browser-send",
  "composer-send",
  "right-rail-connector-action",
  "right-rail-environment-ask",
  "tasks-row-ask",
  "tasks-visible-ask",
  "work-preview-ask-fix",
  "work-preview-browser-issue-fix",
  "work-preview-palette-ask-fix",
  "work-preview-stage-ask-fix",
] as const;

export type DebugProviderAction = typeof DEBUG_PROVIDER_ACTIONS[number];

export interface DebugProviderActionFixture {
  fixtureOnly: true;
  id: typeof DEBUG_PROVIDER_ACTION_FIXTURE_ID;
  action: DebugProviderAction;
  cwd: string;
}

export interface DebugProviderActionReceipt {
  action: DebugProviderAction;
  promptSha256: string;
  runId: string;
}

const BROWSER_COWORK_POLICY = "Work in the visible native ShellX Browser with the explicit task and tab IDs above. Use ShellX Browser tools, preserve operator pause/takeover/abort authority, and keep Vault or sensitive actions inside Request Center. Do not switch to a hidden or unrelated browser surface.";
const BROWSER_EXPLAIN_POLICY = "Summarize what the page is for, the important visible facts/actions, and any security or trust concerns. Do not assume access to user secrets or hidden session data unless the user explicitly grants it.";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function debugProviderActionFixture(
  value: unknown,
): DebugProviderActionFixture | null | undefined {
  if (value === "clear") return null;
  const input = record(value);
  if (input?.id !== DEBUG_PROVIDER_ACTION_FIXTURE_ID) return undefined;
  if (input.action === "clear") return null;
  const action = typeof input.action === "string" && DEBUG_PROVIDER_ACTIONS.includes(input.action as DebugProviderAction)
    ? input.action as DebugProviderAction
    : null;
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  if (!action || !cwd || cwd.length > 4096 || cwd.includes("\0")) return undefined;
  return { fixtureOnly: true, id: DEBUG_PROVIDER_ACTION_FIXTURE_ID, action, cwd };
}

export function providerActionPromptMatches(
  action: DebugProviderAction,
  prompt: string,
): boolean {
  const text = prompt.trim();
  if (text.length < 12 || text.length > 16_384) return false;
  switch (action) {
    case "activity-ask-agent":
      return text.startsWith("Use the ShellX debug API endpoint GET /state/session_activity?")
        && text.includes("summarize this session's file, read/search, git, and terminal activity")
        && text.includes("Separate verified hunk records from observed tool calls");
    case "browser-send":
      return browserCoworkPromptMatches(text, (visiblePrompt) => (
        visiblePrompt === "SHELLX_RELEASE_PROVIDER_ACTION_BROWSER_SEND_035"
      ));
    case "browser-explain-page":
      return browserCoworkPromptMatches(text, (visiblePrompt, currentUrl) => {
        const lines = visiblePrompt.split("\n");
        return lines[0] === "Explain the current browser page for the user."
          && lines[1] === `URL: ${currentUrl}`
          && lines.at(-1) === BROWSER_EXPLAIN_POLICY
          && lines.some((line) => line === "Title: ShellX release settle")
          && lines.some((line) => line.startsWith("Page excerpt: ") && line.includes("Owned Browser settle fixture ready"));
      });
    case "composer-send":
      return text === "SHELLX_RELEASE_PROVIDER_ACTION_COMPOSER_SEND_035";
    case "right-rail-connector-action":
      return text.startsWith("Install the missing launcher for the ShellX release fixture MCP connector")
        && text.includes("First inspect the environment and package manager");
    case "right-rail-environment-ask":
      return text.startsWith("Inspect this shellX environment diagnostic snapshot")
        && text.includes("Environment:")
        && text.includes("Do not edit config, install packages, delete files, or rotate credentials");
    case "tasks-row-ask":
      return text.startsWith("Inspect this shellX background task")
        && text.includes("Task:")
        && text.includes("SHELLX_RELEASE_PROVIDER_ACTION_TASK_035");
    case "tasks-visible-ask":
      return text.startsWith("Inspect the visible shellX background task set")
        && text.includes("Tasks:")
        && text.includes("SHELLX_RELEASE_PROVIDER_ACTION_TASK_035");
    case "work-preview-ask-fix":
    case "work-preview-browser-issue-fix":
    case "work-preview-palette-ask-fix":
    case "work-preview-stage-ask-fix":
      return text.startsWith("Preview Doctor found a problem or the user requested a preview repair pass.")
        && text.includes("Preview context:")
        && text.includes("ui-work-preview-start")
        && text.includes("page title: ShellX release Preview")
        && text.includes("verify it visually before saying it is fixed");
  }
}

function browserCoworkPromptMatches(
  prompt: string,
  visiblePromptMatches: (visiblePrompt: string, currentUrl: string) => boolean,
): boolean {
  const match = prompt.match(/^ShellX Browser cowork request\nBrowser task ID: ([A-Za-z0-9._:-]+)\nBrowser tab ID: ([A-Za-z0-9._:-]+)\nCurrent URL: ([^\n]+)\n\n([^\n]+)\n\nUser message:\n([\s\S]+)$/);
  if (!match || match[4] !== BROWSER_COWORK_POLICY) return false;
  const currentUrl = match[3] ?? "";
  try {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/settle"
      || parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  } catch {
    return false;
  }
  return visiblePromptMatches(match[5] ?? "", currentUrl);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function fixtureReceiptInEvents(
  events: readonly RawEventFrame[],
  tabId: string,
  runId: string,
  expectedText: string,
): boolean {
  return events.some((frame) => {
    if (frame.kind !== "provider-session-event") return false;
    const payload = record(frame.payload);
    return payload?.tabId === tabId
      && payload?.runId === runId
      && payload?.kind === "text"
      && payload?.text === expectedText;
  });
}

export async function dispatchDebugProviderAction(
  fixture: DebugProviderActionFixture,
  prompt: string,
): Promise<DebugProviderActionReceipt> {
  if (!providerActionPromptMatches(fixture.action, prompt)) {
    throw new Error(`release provider action prompt did not match ${fixture.action}`);
  }
  const promptSha256 = await sha256Hex(prompt.trim());
  const tabId = `release-provider-action-${fixture.action}`;
  const request: ProviderSessionStartRequest = {
    tabId,
    providerId: "codex-cli",
    cwd: fixture.cwd,
    prompt: prompt.trim(),
    includeMcpProbe: false,
    includeShellxTooling: false,
    shellxToolExposure: "off",
    persistSession: false,
    resume: false,
    resumeLast: false,
    permissionMode: "readOnly",
    transport: "local",
    releaseFixture: { id: DEBUG_PROVIDER_ACTION_FIXTURE_ID, action: fixture.action },
  };
  const started = await startProviderSession(request);
  const runId = started.run.runId;
  const expectedText = `SHELLX_PROVIDER_ACTION_RECEIPT ${fixture.action} ${promptSha256}`;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const [state, events] = await Promise.all([
      getProviderSessionState(tabId, { transport: "local" }),
      apiGet<RawEventFrame[]>(`/events/recent?tabId=${encodeURIComponent(tabId)}&limit=200`),
    ]);
    const run = state.recentRuns.find((candidate) => candidate.runId === runId);
    if (run?.phase === "failed" || run?.phase === "aborted") {
      throw new Error(`release provider action child ended ${run.phase}: ${run.error ?? "unknown error"}`);
    }
    if (run?.phase === "completed" && fixtureReceiptInEvents(events, tabId, runId, expectedText)) {
      return { action: fixture.action, promptSha256, runId };
    }
    await sleep(40);
  }
  throw new Error(`release provider action ${fixture.action} did not produce its exact process receipt`);
}
