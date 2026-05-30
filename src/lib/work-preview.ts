import { apiGet, apiPostJson } from "./debug-api";

export type WorkPreviewStatus = "idle" | "starting" | "running" | "failed" | "stopped";
export type WorkPreviewKind = "staticHtml" | "webApp" | "expoWeb";
export type WorkPreviewStartKind = "auto" | "static" | "web" | "expo";

export interface WorkPreviewLogLine {
  t: number;
  stream: "stdout" | "stderr" | "system" | string;
  line: string;
}

export interface WorkPreviewBrowserEvent {
  t?: number | null;
  level: string;
  message: string;
  source?: string | null;
  url?: string | null;
  line?: number | null;
  column?: number | null;
  stack?: string | null;
}

export interface WorkPreviewState {
  tabId: string;
  cwd: string | null;
  kind: WorkPreviewKind | null;
  status: WorkPreviewStatus;
  url: string | null;
  command: string | null;
  taskId: string | null;
  pid: number | null;
  startedAtMs: number | null;
  updatedAtMs: number;
  error: string | null;
  logs: WorkPreviewLogLine[];
}

export interface WorkPreviewStartInput {
  tabId: string;
  cwd: string;
  kind?: WorkPreviewStartKind;
  entry?: string;
}

export interface WorkPreviewDiagnoseInput {
  tabId: string;
  browserEvents?: WorkPreviewBrowserEvent[];
}

export interface WorkPreviewDiagnosticIssue {
  severity: "error" | "warning" | "info" | string;
  source: string;
  message: string;
}

export interface WorkPreviewDiagnostic {
  tabId: string;
  ok: boolean;
  status: "passed" | "warning" | "failed" | string;
  summary: string;
  url: string | null;
  cwd: string | null;
  command: string | null;
  httpStatus: number | null;
  responseBytes: number | null;
  title: string | null;
  screenshotPath: string | null;
  screenshotWidth: number | null;
  screenshotHeight: number | null;
  screenshotBrowser: string | null;
  screenshotError: string | null;
  issues: WorkPreviewDiagnosticIssue[];
  browserEvents: WorkPreviewBrowserEvent[];
  logs: WorkPreviewLogLine[];
  state: WorkPreviewState;
}

const BROWSER_EVENT_CAP = 120;
const browserEventsByTab = new Map<string, WorkPreviewBrowserEvent[]>();

export function emptyWorkPreviewState(tabId: string): WorkPreviewState {
  return {
    tabId,
    cwd: null,
    kind: null,
    status: "idle",
    url: null,
    command: null,
    taskId: null,
    pid: null,
    startedAtMs: null,
    updatedAtMs: Date.now(),
    error: null,
    logs: [],
  };
}

export function workPreviewStatusLabel(status: WorkPreviewStatus): string {
  switch (status) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "idle":
    default:
      return "idle";
  }
}

export function workPreviewKindLabel(kind: WorkPreviewKind | null): string {
  switch (kind) {
    case "staticHtml":
      return "Static HTML";
    case "webApp":
      return "Web app";
    case "expoWeb":
      return "Expo web";
    default:
      return "Auto";
  }
}

export function workPreviewActionHint(
  state: Pick<WorkPreviewState, "kind" | "logs" | "error">,
  requestedKind?: WorkPreviewStartKind,
): string | null {
  const text = [state.error ?? "", ...state.logs.map((line) => line.line)]
    .join("\n")
    .toLowerCase();
  const expoRequested = state.kind === "expoWeb" || requestedKind === "expo";
  if (
    expoRequested &&
    (text.includes("trying to use web support") ||
      text.includes("react-native-web") ||
      text.includes("expo install react-dom react-native-web"))
  ) {
    return "Expo web dependencies are missing. Run npx expo install react-dom react-native-web in this app folder, then restart preview.";
  }
  return null;
}

export async function getWorkPreviewState(tabId: string): Promise<WorkPreviewState> {
  return apiGet<WorkPreviewState>(`/preview/work/state?tabId=${encodeURIComponent(tabId)}`);
}

export async function startWorkPreview(input: WorkPreviewStartInput): Promise<WorkPreviewState> {
  return apiPostJson<WorkPreviewState>(
    `/preview/work/start?tabId=${encodeURIComponent(input.tabId)}`,
    {
      tabId: input.tabId,
      cwd: input.cwd,
      kind: input.kind ?? "auto",
      entry: input.entry,
    },
  );
}

export async function stopWorkPreview(tabId: string): Promise<WorkPreviewState> {
  return apiPostJson<WorkPreviewState>(
    `/preview/work/stop?tabId=${encodeURIComponent(tabId)}`,
    { tabId },
  );
}

export async function diagnoseWorkPreview(input: WorkPreviewDiagnoseInput): Promise<WorkPreviewDiagnostic> {
  return apiPostJson<WorkPreviewDiagnostic>(
    `/preview/work/diagnose?tabId=${encodeURIComponent(input.tabId)}`,
    {
      tabId: input.tabId,
      browserEvents: input.browserEvents ?? [],
    },
  );
}

export function recordWorkPreviewBrowserEvent(tabId: string, event: WorkPreviewBrowserEvent): void {
  const safeTabId = tabId || "default";
  const current = browserEventsByTab.get(safeTabId) ?? [];
  current.push({
    ...event,
    message: String(event.message ?? "").slice(0, 4000),
    stack: event.stack ? String(event.stack).slice(0, 8000) : event.stack,
  });
  browserEventsByTab.set(safeTabId, current.slice(-BROWSER_EVENT_CAP));
}

export function getWorkPreviewBrowserEvents(
  tabId: string,
  options?: { url?: string | null; sinceMs?: number | null },
): WorkPreviewBrowserEvent[] {
  const events = [...(browserEventsByTab.get(tabId || "default") ?? [])];
  const sinceMs = typeof options?.sinceMs === "number" ? options.sinceMs : null;
  const url = options?.url ?? null;
  return events.filter((event) => {
    if (sinceMs !== null && typeof event.t === "number" && event.t < sinceMs - 500) {
      return false;
    }
    if (url && event.url && !samePreviewOrigin(event.url, url)) {
      return false;
    }
    return true;
  });
}

export function clearWorkPreviewBrowserEvents(tabId: string): void {
  browserEventsByTab.delete(tabId || "default");
}

export function isStaticHtmlPreviewPath(path: string): boolean {
  return /\.(html?|xhtml)(?:[?#].*)?$/i.test(path.trim());
}

export function workPreviewRootForFilePath(path: string): string | null {
  const clean = stripPathSuffix(path);
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  if (idx <= 0) return null;
  return clean.slice(0, idx);
}

export function workPreviewEntryForFilePath(path: string): string | null {
  const clean = stripPathSuffix(path);
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  const name = idx >= 0 ? clean.slice(idx + 1) : clean;
  return name && !name.includes("/") && !name.includes("\\") ? name : null;
}

function stripPathSuffix(path: string): string {
  return path.split(/[?#]/, 1)[0] ?? path;
}

function samePreviewOrigin(eventUrl: string, previewUrl: string): boolean {
  try {
    return new URL(eventUrl).origin === new URL(previewUrl).origin;
  } catch {
    return eventUrl === previewUrl;
  }
}
