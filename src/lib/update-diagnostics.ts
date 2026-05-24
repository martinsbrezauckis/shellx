export type UpdateErrorKind = "no-release" | "network" | "signature" | "manifest" | "download" | "unknown";
export type UpdateDiagnosticKind = "idle" | "checking" | "current" | "available" | "installing" | "error";
export type DiagnosticAccent = "ok" | "warn" | "bad" | "muted";

export interface UpdateDiagnosticInput {
  currentVersion: string;
  kind: UpdateDiagnosticKind;
  remoteVersion?: string;
  checkedAtMs?: number;
  errorMessage?: string | null;
  progress?: number;
}

export interface UpdateDiagnosticSummary {
  statusLabel: string;
  detail: string;
  accent: DiagnosticAccent;
  errorKind?: UpdateErrorKind;
}

export function classifyUpdateError(message: string | null | undefined): UpdateErrorKind {
  const text = (message ?? "").toLowerCase();
  if (!text.trim()) return "unknown";
  if (/signature|verification|verify|corrupt/.test(text)) return "signature";
  if (/network|enotfound|getaddrinfo|dns|timeout|timed\s*out|connect.*refused|fetch.*failed/.test(text)) return "network";
  if (/download|asset|install/.test(text)) return "download";
  if (/404|\bnot\s+found\b|no\s*update|release.*missing/.test(text)) return "no-release";
  if (/valid release json|latest\.json|manifest|json|parse/.test(text)) return "manifest";
  return "unknown";
}

export function updateErrorIsQuiet(message: string | null | undefined): boolean {
  const kind = classifyUpdateError(message);
  return kind === "no-release" || kind === "network";
}

export function summarizeUpdateDiagnostic(input: UpdateDiagnosticInput): UpdateDiagnosticSummary {
  if (input.kind === "checking") {
    return {
      statusLabel: "checking",
      detail: `Checking GitHub updater for v${input.currentVersion}`,
      accent: "muted",
    };
  }
  if (input.kind === "installing") {
    const pct = Math.round((input.progress ?? 0) * 100);
    return {
      statusLabel: "installing",
      detail: `Installing update${pct > 0 ? ` ${pct}%` : ""}`,
      accent: "ok",
    };
  }
  if (input.kind === "available") {
    return {
      statusLabel: "available",
      detail: `v${input.remoteVersion ?? "new"} available; current is v${input.currentVersion}`,
      accent: "ok",
    };
  }
  if (input.kind === "current") {
    return {
      statusLabel: "current",
      detail: `v${input.currentVersion} is current`,
      accent: "muted",
    };
  }
  if (input.kind === "error") {
    const errorKind = classifyUpdateError(input.errorMessage);
    const accent: DiagnosticAccent = errorKind === "signature" || errorKind === "download" ? "bad" : "warn";
    const label = errorKind === "signature" ? "security"
      : errorKind === "download" ? "download"
        : errorKind === "manifest" ? "manifest"
          : errorKind === "network" ? "network"
            : errorKind === "no-release" ? "no release"
              : "error";
    return {
      statusLabel: label,
      detail: input.errorMessage?.trim() || "Update check failed",
      accent,
      errorKind,
    };
  }
  return {
    statusLabel: "idle",
    detail: `v${input.currentVersion}`,
    accent: "muted",
  };
}
