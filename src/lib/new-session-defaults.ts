import type { AgentSelection } from "./agent-selection";

export interface NewSessionDefaults {
  defaultAgentId: AgentSelection;
  defaultWorkingFolder: string;
}

export const NO_NEW_SESSION_DEFAULTS: NewSessionDefaults = Object.freeze({
  defaultAgentId: null,
  defaultWorkingFolder: "",
});

export interface UntouchedSessionShape {
  sessionId?: string | null;
  firstMessageMs?: number;
  title?: string;
}

export function isUntouchedNewSession(tab: UntouchedSessionShape): boolean {
  return !tab.sessionId
    && !tab.firstMessageMs
    && (!tab.title || tab.title === "new session");
}

export function newSessionWorkingFolder(
  currentWorkingFolder: string,
  defaults: NewSessionDefaults,
): string {
  return defaults.defaultWorkingFolder.trim() || currentWorkingFolder;
}
