export const CUT_TOOLING_STATES = [
  "checking",
  "ready",
  "installedEditorClosed",
  "notInstalled",
  "unsupportedTarget",
  "unavailableToProvider",
  "unavailable",
] as const;

export type CutToolingState = (typeof CUT_TOOLING_STATES)[number];

export function normalizeDebugCutToolingFixture(value: unknown): CutToolingState | "clear" | null {
  if (value === "clear") return "clear";
  return typeof value === "string" && CUT_TOOLING_STATES.includes(value as CutToolingState)
    ? value as CutToolingState
    : null;
}

export interface CutToolingStatus {
  schemaVersion: "shellx.cut.tooling-status.v1";
  status: CutToolingState;
  detail: string;
  target: string;
  canOpen: boolean;
  actionHint?: string;
}

export const CUT_TOOLING_FIXTURES: Record<CutToolingState, CutToolingStatus> = {
  checking: {
    schemaVersion: "shellx.cut.tooling-status.v1",
    status: "checking",
    detail: "Checking the parent desktop-host Cut bridge without opening ShellX Cut.",
    target: "parent desktop host",
    canOpen: false,
  },
  ready: {
    schemaVersion: "shellx.cut.tooling-status.v1",
    status: "ready",
    detail: "ShellX Cut is installed and its editor answered the status check.",
    target: "parent desktop host (local session)",
    canOpen: true,
    actionHint: "Select Open only when you want to focus or start Cut.",
  },
  installedEditorClosed: {
    schemaVersion: "shellx.cut.tooling-status.v1",
    status: "installedEditorClosed",
    detail: "ShellX Cut is installed, but its editor is closed or did not accept the status check.",
    target: "parent desktop host (local session)",
    canOpen: true,
    actionHint: "Select Open to start the installed editor, then Check again.",
  },
  notInstalled: {
    schemaVersion: "shellx.cut.tooling-status.v1",
    status: "notInstalled",
    detail: "ShellX Cut is not installed on this desktop host.",
    target: "parent desktop host (local session)",
    canOpen: false,
    actionHint: "Install ShellX Cut, then select Check.",
  },
  unsupportedTarget: {
    schemaVersion: "shellx.cut.tooling-status.v1",
    status: "unsupportedTarget",
    detail: "ShellX Cut needs an active ShellX desktop-host context. WSL and SSH sessions use the parent host through ShellX Host MCP.",
    target: "no active ShellX host context",
    canOpen: false,
    actionHint: "Start or select a ShellX session with a parent desktop host.",
  },
  unavailableToProvider: {
    schemaVersion: "shellx.cut.tooling-status.v1",
    status: "unavailableToProvider",
    detail: "This provider session has ShellX tooling turned off, so Cut is not available to it.",
    target: "parent desktop host",
    canOpen: false,
    actionHint: "Enable ShellX tools for this provider session, then Check again.",
  },
  unavailable: {
    schemaVersion: "shellx.cut.tooling-status.v1",
    status: "unavailable",
    detail: "ShellX Cut is unavailable on this target.",
    target: "parent desktop host",
    canOpen: false,
  },
};

export function cutToolingPresentation(status: CutToolingStatus): {
  label: string;
  className: "ok" | "warn" | "bad" | "muted";
} {
  switch (status.status) {
    case "ready":
      return { label: "ready", className: "ok" };
    case "checking":
      return { label: "checking", className: "muted" };
    case "installedEditorClosed":
      return { label: "editor closed", className: "warn" };
    case "notInstalled":
      return { label: "not installed", className: "warn" };
    case "unsupportedTarget":
      return { label: "unsupported target", className: "warn" };
    case "unavailableToProvider":
      return { label: "unavailable to provider", className: "warn" };
    case "unavailable":
      return { label: "unavailable", className: "bad" };
  }
}
