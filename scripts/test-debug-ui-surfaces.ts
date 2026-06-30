import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellxHomeCandidates } from "./shellx-debug-paths";

type Json = Record<string, unknown>;
type DebugHighlightResult = {
  id?: string;
  selector?: string;
  status?: string;
  message?: string | null;
};
type Step = {
  name: string;
  body: Json;
  expectedSelectors?: string[];
};
type DebugConnection = {
  shellxHome: string;
  base: string;
  token: string;
};

function readTrim(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

async function resolveDebugConnection(): Promise<DebugConnection> {
  const baseOverride = process.env.SHELLX_DEBUG_BASE?.trim();
  const portOverride = process.env.SHELLX_DEBUG_PORT?.trim();
  const tokenOverride = process.env.SHELLX_DEBUG_TOKEN?.trim();
  const errors: string[] = [];
  for (const dir of shellxHomeCandidates()) {
    const port = portOverride || readTrim(join(dir, "debug-api.port"));
    const token = tokenOverride || readTrim(join(dir, "shellxagent.token"));
    if (!port || !token) {
      errors.push(`${dir}: missing ${!port ? "debug-api.port" : "shellxagent.token"}`);
      continue;
    }
    const base = baseOverride || `http://127.0.0.1:${port}`;
    try {
      const res = await request(base, token, "/health");
      if (res.ok) return { shellxHome: dir, base, token };
      errors.push(`${dir}: /health ${res.status}`);
    } catch (error) {
      errors.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`ShellX debug API is not reachable from candidate homes: ${errors.join("; ")}`);
}

async function request(
  base: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${base}${path}`, { ...init, headers });
}

async function postUi(base: string, token: string, body: Json): Promise<void> {
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${base}/state/ui`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST /state/ui failed ${res.status}: ${await res.text()}`);
}

async function getJson<T>(base: string, token: string, path: string): Promise<T> {
  const res = await request(base, token, path);
  if (!res.ok) throw new Error(`GET ${path} failed ${res.status}: ${await res.text()}`);
  return await res.json() as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectedSelectors(name: string, selectors: string[]): Json[] {
  return selectors.map((selector, index) => ({
    id: `${name}-${index}`,
    selector,
    label: name,
    color: "blue",
  }));
}

function stepBody(step: Step): Json {
  if (step.expectedSelectors?.length) {
    return { ...step.body, debugHighlights: expectedSelectors(step.name, step.expectedSelectors) };
  }
  if (Object.prototype.hasOwnProperty.call(step.body, "debugHighlights")) return step.body;
  return { ...step.body, debugHighlights: [] };
}

async function waitForDebugSelectors(
  base: string,
  token: string,
  name: string,
  selectors: string[],
): Promise<void> {
  const expectedIds = selectors.map((_, index) => `${name}-${index}`);
  const deadline = Date.now() + 20_000;
  let lastResults: DebugHighlightResult[] = [];
  while (Date.now() < deadline) {
    const ui = await getJson<{ debugHighlightResults?: DebugHighlightResult[] }>(base, token, "/state/ui");
    lastResults = Array.isArray(ui.debugHighlightResults) ? ui.debugHighlightResults : [];
    const byId = new Map(lastResults.map((result) => [result.id, result]));
    const allResolved = expectedIds.every((id) => byId.get(id)?.status === "resolved");
    if (allResolved) return;
    await sleep(150);
  }
  const status = expectedIds.map((id) => {
    const result = lastResults.find((entry) => entry.id === id);
    return {
      id,
      selector: result?.selector ?? selectors[Number(id.split("-").pop() ?? "0")] ?? null,
      status: result?.status ?? "missing-result",
      message: result?.message ?? null,
    };
  });
  throw new Error(`surface ${name} did not resolve expected selectors: ${JSON.stringify(status)}`);
}

async function screenshot(base: string, token: string, outDir: string, name: string): Promise<void> {
  await sleep(250);
  const fullScreen = process.env.SHELLX_DEBUG_SCREENSHOT_FULL === "1";
  const res = await request(base, token, fullScreen ? "/screenshot?fullScreen=1" : "/screenshot");
  if (!res.ok) throw new Error(`GET /screenshot failed ${res.status}: ${await res.text()}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 10_000) throw new Error(`screenshot for ${name} is unexpectedly small (${bytes.length} bytes)`);
  writeFileSync(join(outDir, `${name}.png`), bytes);
}

async function waitForFreshActiveTab(base: string, token: string, previousActiveTabId: string | null): Promise<string> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const ui = await getJson<{ activeTabId?: string | null }>(base, token, "/state/ui");
    const activeTabId = ui.activeTabId ?? null;
    if (activeTabId && activeTabId !== previousActiveTabId) return activeTabId;
    await sleep(150);
  }
  throw new Error("fresh debug UI session tab did not become active");
}

async function openFreshComposerTab(base: string, token: string): Promise<string> {
  const before = await getJson<{ activeTabId?: string | null }>(base, token, "/state/ui");
  await postUi(base, token, {
    openModal: "palette",
    debugHighlights: expectedSelectors("new-session-palette", ["[data-debug-id='command-palette-input']"]),
  });
  await waitForDebugSelectors(base, token, "new-session-palette", ["[data-debug-id='command-palette-input']"]);
  await postUi(base, token, {
    clickSelector: { selector: "button.palette-row", text: "New session" },
    debugHighlights: [],
  });
  const activeTabId = await waitForFreshActiveTab(base, token, before.activeTabId ?? null);
  await postUi(base, token, { openModal: "close", composerMenu: "close", bottomTab: "Chat", debugHighlights: [] });
  return activeTabId;
}

async function main(): Promise<void> {
  const { shellxHome, base, token } = await resolveDebugConnection();
  const outDir = process.env.SHELLX_DEBUG_SURFACE_OUT ?? join(process.cwd(), "tmp", "debug-ui-surfaces");
  mkdirSync(outDir, { recursive: true });
  console.log(`debugApi=${base}`);
  console.log(`shellxHome=${shellxHome}`);

  await postUi(base, token, { openModal: "close", composerMenu: "close", bottomTab: "Chat" });
  const freshTabId = await openFreshComposerTab(base, token);

  const steps: Step[] = [
    { name: "right-tasks", body: { rightTab: "Tasks" } },
    { name: "right-tooling", body: { rightTab: "Tooling" } },
    { name: "right-git", body: { rightTab: "Git" } },
    { name: "right-preview", body: { rightTab: "Preview" } },
    { name: "right-plan", body: { rightTab: "Plan" } },
    { name: "right-files", body: { rightTab: "Files" } },
    { name: "bottom-chat", body: { bottomTab: "Chat" } },
    { name: "bottom-terminal", body: { bottomTab: "Terminal" } },
    { name: "bottom-logs", body: { bottomTab: "Logs" } },
    { name: "bottom-stderr", body: { bottomTab: "Stderr" } },
    { name: "modal-settings", body: { openModal: "settings" }, expectedSelectors: [".settings-modal"] },
    { name: "modal-settings-close", body: { openModal: "close" } },
    { name: "modal-palette", body: { openModal: "palette" }, expectedSelectors: ["[data-debug-id='command-palette-input']"] },
    { name: "modal-help", body: { openModal: "help" }, expectedSelectors: ["[aria-label='Keyboard shortcuts']"] },
    { name: "modal-plugins", body: { openModal: "plugins" }, expectedSelectors: [".plugins-modal"] },
    { name: "modal-connector-inbox", body: { openModal: "connectorInbox" }, expectedSelectors: [".connector-inbox-modal"] },
    { name: "modal-assets", body: { openModal: "assets" }, expectedSelectors: [".asset-board-modal"] },
    { name: "modal-preview", body: { openModal: "preview" }, expectedSelectors: [".preview-center-modal"] },
    { name: "debug-click-preview-close", body: { debugClick: "button.preview-center-close" } },
    { name: "modal-work-preview", body: { openModal: "workPreview" }, expectedSelectors: [".preview-center-modal"] },
    { name: "modal-build-plan-review-command", body: { openModal: "buildPlanReview" } },
    { name: "modal-activity", body: { openModal: "activity" }, expectedSelectors: [".activity-modal"] },
    { name: "activity-search", body: { debugInput: { selector: "[data-debug-id='activity-search']", value: "git commit" } }, expectedSelectors: ["[data-debug-id='activity-search']"] },
    { name: "modal-pr", body: { openModal: "pr" }, expectedSelectors: [".pr-modal"] },
    {
      name: "modal-vault",
      body: { openModal: "vault" },
      expectedSelectors: [
        "[data-debug-id='vault-workspace-modal']",
        "[data-debug-id='vault-filter-input']",
        "[data-debug-id='vault-secret-key-input']",
        "[data-debug-id='vault-generate-password']",
      ],
    },
    { name: "cwd-picker", body: { openModal: "close", cwdPicker: { path: "/", label: "Debug cwd" } }, expectedSelectors: ["[data-debug-id='remote-cwd-input']"] },
    { name: "cwd-picker-close", body: { cwdPicker: { open: false } } },
    {
      name: "palette-filtered",
      body: { openModal: "palette", debugInput: { selector: "[data-debug-id='command-palette-input']", value: "settings" } },
      expectedSelectors: ["[data-debug-id='command-palette-input']"],
    },
    {
      name: "composer-typed",
      body: { openModal: "close", bottomTab: "Chat", debugInput: { selector: "[data-debug-id='composer-prompt']", value: "/help" } },
      expectedSelectors: ["[data-debug-id='composer-prompt']"],
    },
    {
      name: "composer-highlighted",
      body: { openModal: "close", bottomTab: "Chat" },
      expectedSelectors: [
        "[data-debug-id='composer']",
        "[data-debug-id='composer-voice-chat']",
        "[data-debug-id='composer-send']",
      ],
    },
    {
      name: "click-selector-alias",
      body: { openModal: "palette", clickSelector: { selector: "button.palette-row", text: "settings" } },
      expectedSelectors: [".settings-modal"],
    },
    {
      name: "composer-connection",
      body: { openModal: "close", bottomTab: "Chat", composerMenu: "connection" },
      expectedSelectors: [".connection-picker-pop"],
    },
    { name: "composer-agent", body: { composerMenu: "agent" }, expectedSelectors: ["[data-agent-picker-root]"] },
    { name: "composer-branch", body: { composerMenu: "branch" }, expectedSelectors: [".branch-picker--portal"] },
    { name: "composer-close", body: { composerMenu: "close" } },
  ];

  steps.splice(0, 0, { name: "session-tab-focus", body: { activeTabId: freshTabId } });

  for (const step of steps) {
    await postUi(base, token, stepBody(step));
    if (step.expectedSelectors?.length) {
      await waitForDebugSelectors(base, token, step.name, step.expectedSelectors);
    }
    const name = step.name;
    await screenshot(base, token, outDir, name);
    console.log(`captured ${name}`);
  }

  await postUi(base, token, {
    openModal: "close",
    composerMenu: "close",
    bottomTab: "Chat",
    debugHighlights: [],
    debugInput: { selector: "[data-debug-id='composer-prompt']", value: "" },
  });

  console.log(`debug UI surface screenshots: ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
