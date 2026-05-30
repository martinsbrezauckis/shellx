import { useMemo, useState } from "react";
import type { JSX } from "react";
import {
  buildReleaseRunbook,
  buildReleaseReadinessChecks,
  summarizeReleaseReadiness,
  type ReleaseReadinessCheck,
} from "../../lib/release-readiness";
import { ShellIcon } from "../icons";

interface ReleaseReadinessPanelProps {
  version: string;
  cargoVersion: string;
  tauriVersion: string;
}

export default function ReleaseReadinessPanel({
  version,
  cargoVersion,
  tauriVersion,
}: ReleaseReadinessPanelProps): JSX.Element {
  const releaseDoneKey = `shellx.releaseReadiness.${version}`;
  const [releaseDone, setReleaseDone] = useState<Record<string, boolean>>(() => {
    try {
      const raw = window.localStorage.getItem(releaseDoneKey);
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  function setReleaseGate(id: string, passed: boolean): void {
    setReleaseDone((prev) => {
      const next = { ...prev, [id]: passed };
      if (!passed) delete next[id];
      try {
        window.localStorage.setItem(releaseDoneKey, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  function copyReleaseCommand(check: ReleaseReadinessCheck): void {
    if (!check.command) return;
    try {
      void navigator.clipboard.writeText(check.command);
    } catch {
      /* ignore */
    }
    setCopiedCommand(check.id);
    window.setTimeout(() => setCopiedCommand(null), 1200);
  }

  function copyRemainingChecklist(): void {
    const remaining = releaseChecks.filter((check) => check.status !== "pass");
    const body = remaining.length === 0
      ? [`shellX v${version} release readiness: all gates marked pass.`]
      : [
          `shellX v${version} remaining release gates:`,
          "",
          ...remaining.flatMap((check) => [
            `- [ ] ${check.label} (${check.status})`,
            `  ${check.detail}`,
            ...(check.command ? [`  Command: ${check.command}`] : []),
          ]),
        ];
    try {
      void navigator.clipboard.writeText(body.join("\n"));
    } catch {
      /* ignore */
    }
    setCopiedCommand("__remaining__");
    window.setTimeout(() => setCopiedCommand(null), 1200);
  }

  function copyReleaseRunbook(): void {
    try {
      void navigator.clipboard.writeText(buildReleaseRunbook({ version, checks: releaseChecks }));
    } catch {
      /* ignore */
    }
    setCopiedCommand("__runbook__");
    window.setTimeout(() => setCopiedCommand(null), 1200);
  }

  const releaseChecks = useMemo(
    () =>
      buildReleaseReadinessChecks({
        packageVersion: version,
        cargoVersion,
        tauriVersion,
        workRepoClean: !!releaseDone["work-repo-clean"],
        publicExportClean: !!releaseDone["public-export-clean"],
        changelogUpdated: !!releaseDone.changelog,
        publicBoundaryChecked: !!releaseDone["public-boundary"],
        rustTestsVerified: !!releaseDone["rust-tests"],
        rustCheckVerified: !!releaseDone["rust-check"],
        rustLintVerified: !!releaseDone["rust-lint"],
        dependencyAuditVerified: !!releaseDone["dependency-audit"],
        semgrepScanVerified: !!releaseDone["semgrep-scan"],
        jsTestsVerified: !!releaseDone["js-tests"],
        typecheckVerified: !!releaseDone.typecheck,
        windowsArtifact: !!releaseDone["windows-artifact"],
        windowsSignature: !!releaseDone["windows-signature"],
        linuxArtifact: !!releaseDone["linux-artifact"],
        macAppSmoke: !!releaseDone["mac-app-smoke"],
        macSignedNotarized: !!releaseDone["mac-signed-notarized"],
        macArtifact: !!releaseDone["mac-artifact"],
        ciGrokShimVerified: !!releaseDone["ci-grok-shim"],
        githubCiGreen: !!releaseDone["github-ci"],
      }),
    [cargoVersion, releaseDone, tauriVersion, version],
  );
  const releaseSummary = useMemo(
    () => summarizeReleaseReadiness(releaseChecks),
    [releaseChecks],
  );
  const progressPct = Math.round((releaseSummary.pass / Math.max(releaseChecks.length, 1)) * 100);

  return (
    <section className={`release-readiness release-readiness-${releaseSummary.accent}`}>
      <div className="release-readiness-head">
        <div>
          <div className="release-readiness-title">Release readiness</div>
          <div className="release-readiness-meta">
            {releaseSummary.statusLabel} · {releaseSummary.pass} pass ·{" "}
            {releaseSummary.warn} warn · {releaseSummary.fail} blocked
          </div>
        </div>
        <div className="release-readiness-head-actions">
          <button
            type="button"
            className="settings-pill"
            onClick={copyRemainingChecklist}
            title="Copy remaining release gates and commands"
          >
            <ShellIcon name={copiedCommand === "__remaining__" ? "check" : "copy"} size={12} />
            Remaining
          </button>
          <button
            type="button"
            className="settings-pill"
            onClick={copyReleaseRunbook}
            title="Copy ordered release runbook with approval reminders"
          >
            <ShellIcon name={copiedCommand === "__runbook__" ? "check" : "copy"} size={12} />
            Runbook
          </button>
          <span className="release-version-chip">v{version}</span>
        </div>
      </div>
      <div className="release-readiness-progress" aria-label={`Release readiness ${progressPct}%`}>
        <span style={{ width: `${progressPct}%` }} />
      </div>
      <div className="release-readiness-list">
        {releaseChecks.map((check) => {
          const done = check.status === "pass";
          return (
            <div className={`release-check release-check-${check.status}`} key={check.id}>
              <div className="release-check-main">
                <ShellIcon
                  name={
                    check.status === "pass"
                      ? "circle-check"
                      : check.status === "warn"
                        ? "alert"
                        : "circle-x"
                  }
                  size={14}
                />
                <div>
                  <div className="release-check-label">{check.label}</div>
                  <div className="release-check-detail">{check.detail}</div>
                </div>
              </div>
              <div className="release-check-actions">
                {check.command && (
                  <button
                    type="button"
                    className="settings-pill"
                    onClick={() => copyReleaseCommand(check)}
                    title={check.command}
                  >
                    <ShellIcon name={copiedCommand === check.id ? "check" : "copy"} size={12} />
                  </button>
                )}
                {check.id !== "publish-approval" && (
                  <button
                    type="button"
                    className="settings-pill"
                    onClick={() => setReleaseGate(check.id, !done)}
                  >
                    {done ? "Clear" : "Mark pass"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
