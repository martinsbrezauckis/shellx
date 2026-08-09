export interface ComposerSubmissionState {
  isSending: boolean;
  selectedAgent: string | null;
  status: string;
  text: string;
  attachmentCount: number;
}

export type ComposerSubmissionDecision =
  | { mode: "prompt" }
  | { mode: "interject" }
  | { mode: "blocked"; message: string };

function isRunningTurnLocalControl(text: string): boolean {
  return text === "/commands"
    || text === "/pause"
    || text === "/resume"
    || text === "/stop"
    || text === "/pr"
    || text.startsWith("/pr ");
}

function isBuildStartCommand(text: string): boolean {
  return text === "/build"
    || text.startsWith("/build ")
    || text === "/goal"
    || text.startsWith("/goal ");
}

export function classifyComposerSubmission(
  state: ComposerSubmissionState,
): ComposerSubmissionDecision {
  if (!state.isSending) return { mode: "prompt" };
  const text = state.text.trim();
  if (isRunningTurnLocalControl(text)) return { mode: "prompt" };
  if (isBuildStartCommand(text)) {
    return {
      mode: "blocked",
      message: "Stop or finish the current turn before starting a new build.",
    };
  }
  if (state.selectedAgent !== "grok" || state.status !== "Connected") {
    return {
      mode: "blocked",
      message: "Mid-turn steering is available only for a connected Grok session.",
    };
  }
  if (!text) {
    return { mode: "blocked", message: "Mid-turn steering currently requires text." };
  }
  if (state.attachmentCount > 0) {
    return { mode: "blocked", message: "Attachments cannot be added to a running turn yet." };
  }
  return { mode: "interject" };
}
