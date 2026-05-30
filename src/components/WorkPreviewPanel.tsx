import { useEffect, useMemo, useRef, useState, type JSX, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  clearWorkPreviewBrowserEvents,
  emptyWorkPreviewState,
  diagnoseWorkPreview,
  getWorkPreviewState,
  getWorkPreviewBrowserEvents,
  recordWorkPreviewBrowserEvent,
  startWorkPreview,
  stopWorkPreview,
  workPreviewActionHint,
  workPreviewKindLabel,
  workPreviewStatusLabel,
  type WorkPreviewBrowserEvent,
  type WorkPreviewDiagnostic,
  type WorkPreviewStartKind,
  type WorkPreviewState,
} from "../lib/work-preview";
import { inTauri } from "../lib/tauri-bridge";
import { ShellIcon } from "./icons";

const START_OPTIONS: Array<{ id: WorkPreviewStartKind; label: string; help: string }> = [
  { id: "auto", label: "Auto", help: "Detect Expo, package dev scripts, or static HTML." },
  { id: "static", label: "Static", help: "Serve a folder or standalone HTML file." },
  { id: "web", label: "Web", help: "Run the project dev script from package.json." },
  { id: "expo", label: "Expo", help: "Run Expo for a phone-first web preview." },
];
const LOG_HEIGHT_KEY = "shellx.workPreview.logHeight";
const LOG_HEIGHT_DEFAULT = 260;
const LOG_HEIGHT_MIN = 150;
const LOG_HEIGHT_MAX = 620;

function initialLogHeight(): number {
  try {
    const raw = window.localStorage.getItem(LOG_HEIGHT_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    if (Number.isFinite(parsed)) {
      return clampLogHeight(parsed);
    }
  } catch {
    /* no-op */
  }
  return LOG_HEIGHT_DEFAULT;
}

function clampLogHeight(value: number): number {
  return Math.max(LOG_HEIGHT_MIN, Math.min(LOG_HEIGHT_MAX, Math.round(value)));
}

export function WorkPreviewPanel({
  activeTabId,
  cwd,
  onStateChange,
  onOpenPreview,
  onAskGrokToFix,
}: {
  activeTabId: string | null;
  cwd: string;
  onStateChange?: (state: WorkPreviewState) => void;
  onOpenPreview?: (state: WorkPreviewState) => void;
  onAskGrokToFix?: (state: WorkPreviewState) => void;
}): JSX.Element {
  const tabId = activeTabId || "default";
  const [state, setState] = useState<WorkPreviewState>(() => emptyWorkPreviewState(tabId));
  const [kind, setKind] = useState<WorkPreviewStartKind>("auto");
  const [logHeight, setLogHeight] = useState(initialLogHeight);
  const [busy, setBusy] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnostic, setDiagnostic] = useState<WorkPreviewDiagnostic | null>(null);
  const [diagnosticCopied, setDiagnosticCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragStartRef = useRef<{ y: number; height: number } | null>(null);
  const displayCwd = state.cwd || cwd;
  const canStart = !!displayCwd && !busy && inTauri();
  const running = state.status === "running" || state.status === "starting";
  const hasUrl = Boolean(state.url);
  const startLabel = state.status === "failed" ? "Retry" : "Start";
  const selectedOption = START_OPTIONS.find((option) => option.id === kind) ?? START_OPTIONS[0]!;
  const statusHeadline = state.status === "running"
    ? "Preview ready"
    : state.status === "starting"
      ? "Starting preview"
      : state.status === "failed"
        ? "Preview failed"
        : state.status === "stopped"
          ? "Preview stopped"
          : "No preview running";
  const statusDetail = hasUrl
    ? `${workPreviewKindLabel(state.kind)} is available for this session.`
    : state.status === "failed"
      ? state.error ?? "Check the logs below for the failing command."
      : displayCwd
        ? "Start a preview when this session contains an HTML, web, or Expo app."
        : "Choose a project folder before starting a preview.";

  const logText = useMemo(
    () =>
      state.logs
        .slice(-240)
        .map((line) => `[${line.stream}] ${line.line}`)
        .join("\n"),
    [state.logs],
  );
  const actionHint = useMemo(
    () => workPreviewActionHint(state, kind),
    [kind, state.error, state.kind, state.logs],
  );

  async function refresh(): Promise<void> {
    if (!inTauri()) return;
    try {
      const next = await getWorkPreviewState(tabId);
      setState(next);
      onStateChange?.(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function start(): Promise<void> {
    if (!canStart) return;
    setBusy(true);
    setError(null);
    try {
      const next = await startWorkPreview({
        tabId,
        cwd: displayCwd,
        kind,
      });
      clearWorkPreviewBrowserEvents(tabId);
      setState(next);
      onStateChange?.(next);
      setDiagnostic(null);
      if (next.url) onOpenPreview?.(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function stop(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await stopWorkPreview(tabId);
      setState(next);
      onStateChange?.(next);
      setDiagnostic(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openExternal(): Promise<void> {
    if (!state.url) return;
    try {
      await invoke("open_url_in_browser", { url: state.url });
    } catch {
      window.open(state.url, "_blank", "noopener,noreferrer");
    }
  }

  async function copyUrl(): Promise<void> {
    if (!state.url) return;
    try {
      await navigator.clipboard.writeText(state.url);
    } catch {
      /* ignore */
    }
  }

  async function runDoctor(): Promise<void> {
    if (!inTauri() || diagnosing) return;
    setDiagnosing(true);
    setError(null);
    try {
      const next = await diagnoseWorkPreview({
        tabId,
        browserEvents: getWorkPreviewBrowserEvents(tabId, {
          url: state.url,
          sinceMs: state.startedAtMs,
        }),
      });
      setDiagnostic(next);
      setState(next.state);
      onStateChange?.(next.state);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiagnosing(false);
    }
  }

  async function copyDoctorReport(): Promise<void> {
    if (!diagnostic) return;
    try {
      await navigator.clipboard.writeText(formatPreviewDoctorReport(diagnostic));
      setDiagnosticCopied(true);
      window.setTimeout(() => setDiagnosticCopied(false), 1200);
    } catch {
      /* ignore */
    }
  }

  function resizeLogs(nextHeight: number): void {
    const clamped = clampLogHeight(nextHeight);
    setLogHeight(clamped);
    try {
      window.localStorage.setItem(LOG_HEIGHT_KEY, String(clamped));
    } catch {
      /* no-op */
    }
  }

  function onLogResizePointerDown(event: PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const target = event.currentTarget;
    dragStartRef.current = { y: event.clientY, height: logHeight };
    target.setPointerCapture(event.pointerId);
    document.body.classList.add("work-preview-log-resizing");
  }

  function onLogResizePointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (!dragStartRef.current) return;
    const delta = dragStartRef.current.y - event.clientY;
    resizeLogs(dragStartRef.current.height + delta);
  }

  function onLogResizePointerUp(event: PointerEvent<HTMLDivElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragStartRef.current = null;
    document.body.classList.remove("work-preview-log-resizing");
  }

  useEffect(() => {
    const next = emptyWorkPreviewState(tabId);
    setState(next);
    onStateChange?.(next);
    setDiagnostic(null);
    setError(null);
    void refresh();
  }, [tabId]);

  useEffect(() => {
    if (!inTauri()) return;
    const id = window.setInterval(() => void refresh(), running ? 1500 : 4000);
    return () => window.clearInterval(id);
  }, [tabId, running]);

  if (!inTauri()) {
    return (
      <div className="rail-empty">
        <div className="rail-empty-line">Preview needs the desktop host.</div>
        <div className="rail-empty-hint">Run shellX as a Tauri app to start local preview servers.</div>
      </div>
    );
  }

  return (
    <div className="work-preview-pane">
      <div className="work-preview-head">
        <div>
          <div className="tooling-title work-preview-title">
            <ShellIcon name="app-window" size={14} />
            <span>Work Preview</span>
          </div>
          <div className="tooling-meta">
            <span>{workPreviewStatusLabel(state.status)}</span>
            <span>{workPreviewKindLabel(state.kind)}</span>
            {state.pid && <span>pid {state.pid}</span>}
          </div>
        </div>
        <div className="work-preview-actions">
          <button type="button" className="mp-action-btn mp-action-btn-secondary" onClick={() => void refresh()} title="Refresh preview state">
            <ShellIcon name="refresh" size={12} />
          </button>
        </div>
      </div>

      <div className="work-preview-main">
        <div className={`work-preview-status work-preview-status-${state.status}`}>
          <div>
            <div className="work-preview-status-title">{statusHeadline}</div>
            <div className="work-preview-status-detail">{statusDetail}</div>
          </div>
          <div className="work-preview-primary-actions">
            {hasUrl ? (
              <button type="button" className="mp-action-btn mp-action-btn-primary" onClick={() => onOpenPreview?.(state)}>
                <ShellIcon name="app-window" size={12} />
                Open
              </button>
            ) : (
              <button type="button" className="mp-action-btn mp-action-btn-primary" onClick={() => void start()} disabled={!canStart}>
                <ShellIcon name={busy ? "loader" : "play"} size={12} />
                {startLabel}
              </button>
            )}
            {hasUrl && (
              <button type="button" className="mp-action-btn mp-action-btn-secondary" onClick={() => void start()} disabled={!canStart}>
                <ShellIcon name={busy ? "loader" : "rotate"} size={12} />
                Restart
              </button>
            )}
            <button type="button" className="mp-action-btn mp-action-btn-secondary" onClick={() => void stop()} disabled={!running || busy}>
              <ShellIcon name="square" size={12} />
              Stop
            </button>
            {(hasUrl || state.status === "failed") && onAskGrokToFix && (
              <button type="button" className="mp-action-btn mp-action-btn-secondary" onClick={() => onAskGrokToFix(state)} disabled={busy}>
                <ShellIcon name="alert" size={12} />
                Ask Fix
              </button>
            )}
            {(hasUrl || state.status === "failed") && (
              <button type="button" className="mp-action-btn mp-action-btn-secondary" onClick={() => void runDoctor()} disabled={busy || diagnosing}>
                <ShellIcon name={diagnosing ? "loader" : "shield-alert"} size={12} />
                Doctor
              </button>
            )}
          </div>
        </div>

        <div className="work-preview-controls">
          <div className="work-preview-segments" role="tablist" aria-label="Preview kind">
            {START_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={kind === option.id ? "active" : ""}
                onClick={() => setKind(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="work-preview-mode-help">{selectedOption.help}</div>
        </div>

        <div className="work-preview-path" title={cwd || undefined}>
          <ShellIcon name="folder" size={12} />
          <span>{displayCwd || "No project folder selected"}</span>
        </div>

        {(error || state.error) && (
          <div className="rail-empty tooling-error work-preview-error">
            <div className="rail-empty-line">Preview failed.</div>
            <div className="rail-empty-hint"><code>{error || state.error}</code></div>
          </div>
        )}

        {actionHint && (
          <div className="rail-empty work-preview-hint">
            <div className="rail-empty-line">Preview needs project setup.</div>
            <div className="rail-empty-hint">{actionHint}</div>
          </div>
        )}

        {diagnostic && (
          <div className={`work-preview-doctor-card work-preview-doctor-${diagnostic.status}`}>
            <div className="work-preview-doctor-head">
              <div>
                <div className="work-preview-doctor-title">
                  <ShellIcon name={diagnostic.ok ? "circle-check" : "alert"} size={13} />
                  Preview Doctor
                </div>
                <div className="work-preview-doctor-summary">{diagnostic.summary}</div>
              </div>
              <button type="button" className="settings-pill" onClick={() => void copyDoctorReport()} title="Copy Preview Doctor report">
                <ShellIcon name={diagnosticCopied ? "check" : "copy"} size={12} />
                Report
              </button>
            </div>
            <div className="work-preview-doctor-meta">
              {diagnostic.httpStatus !== null && <span>HTTP {diagnostic.httpStatus}</span>}
              {diagnostic.title && <span title={diagnostic.title}>{diagnostic.title}</span>}
              {diagnostic.screenshotPath && <span title={diagnostic.screenshotPath}>screenshot captured</span>}
              {diagnostic.screenshotError && <span title={diagnostic.screenshotError}>screenshot unavailable</span>}
            </div>
            {diagnostic.issues.length > 0 && (
              <div className="work-preview-doctor-issues">
                {diagnostic.issues.slice(0, 5).map((issue, index) => (
                  <div className={`work-preview-doctor-issue work-preview-doctor-issue-${issue.severity}`} key={`${issue.source}-${index}`}>
                    <span>{issue.severity}</span>
                    <span>{issue.source}: {issue.message}</span>
                  </div>
                ))}
                {diagnostic.issues.length > 5 && (
                  <div className="work-preview-doctor-more">+{diagnostic.issues.length - 5} more issue{diagnostic.issues.length - 5 === 1 ? "" : "s"}</div>
                )}
              </div>
            )}
          </div>
        )}

        {state.url ? (
          <div className="work-preview-url-card">
            <div className="work-preview-urlbar">
              <span title={state.url}>{state.url}</span>
              <button type="button" className="settings-pill" onClick={() => void copyUrl()} title="Copy URL">
                <ShellIcon name="copy" size={12} />
              </button>
              <button type="button" className="settings-pill" onClick={() => void openExternal()} title="Open externally">
                <ShellIcon name="external-link" size={12} />
              </button>
            </div>
          </div>
        ) : (
          <div className="rail-empty work-preview-empty">
            <div className="rail-empty-line">No preview running.</div>
            <div className="rail-empty-hint">Start a static HTML, web, or Expo web preview for the active project.</div>
          </div>
        )}
      </div>

      <div className="work-preview-log" style={{ flexBasis: `${logHeight}px` }}>
        <div
          className="work-preview-log-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize preview logs"
          title="Drag to resize preview logs"
          onPointerDown={onLogResizePointerDown}
          onPointerMove={onLogResizePointerMove}
          onPointerUp={onLogResizePointerUp}
          onPointerCancel={onLogResizePointerUp}
        >
          <span />
        </div>
        <div className="work-preview-log-head">
          <div className="tooling-section-label">Preview logs</div>
          <div className="work-preview-log-actions">
            <span>{state.logs.length} lines</span>
            <button
              type="button"
              className="settings-pill"
              onClick={() => resizeLogs(logHeight < 360 ? 430 : LOG_HEIGHT_DEFAULT)}
              title={logHeight < 360 ? "Expand preview logs" : "Restore preview logs height"}
            >
              <ShellIcon name={logHeight < 360 ? "maximize" : "minimize"} size={12} />
            </button>
          </div>
        </div>
        <pre>{logText || "No preview logs yet."}</pre>
      </div>
    </div>
  );
}

export function WorkPreviewStage({
  state,
  onClose,
  onAskGrokToFix,
  showClose = true,
}: {
  state: WorkPreviewState | null;
  onClose?: () => void;
  onAskGrokToFix?: (state: WorkPreviewState) => void;
  showClose?: boolean;
}): JSX.Element {
  const effective = state ?? emptyWorkPreviewState("default");
  const hasUrl = Boolean(effective.url);
  const isRunning = effective.status === "running" || effective.status === "starting";
  const defaultViewport = effective.kind === "expoWeb" ? "phone" : "desktop";
  const [viewport, setViewport] = useState<"phone" | "tablet" | "desktop">(defaultViewport);
  const [frameReloadSeq, setFrameReloadSeq] = useState(0);
  const [browserIssueCount, setBrowserIssueCount] = useState(0);
  const [lastBrowserIssue, setLastBrowserIssue] = useState<WorkPreviewBrowserEvent | null>(null);
  const frameRevision = effective.startedAtMs ?? effective.updatedAtMs;
  const frameSrc = useMemo(
    () => effective.url ? cacheBustPreviewUrl(effective.url, frameRevision, frameReloadSeq) : null,
    [effective.url, frameRevision, frameReloadSeq],
  );

  useEffect(() => {
    setViewport(effective.kind === "expoWeb" ? "phone" : "desktop");
  }, [effective.kind]);

  useEffect(() => {
    setFrameReloadSeq(0);
  }, [effective.url, frameRevision]);

  useEffect(() => {
    const issues = getWorkPreviewBrowserEvents(effective.tabId, {
      url: effective.url,
      sinceMs: effective.startedAtMs,
    }).filter(isPreviewBrowserIssue);
    setBrowserIssueCount(issues.length);
    setLastBrowserIssue(issues[issues.length - 1] ?? null);
  }, [effective.tabId, effective.url, frameRevision]);

  useEffect(() => {
    if (!onClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!effective.url) return;
    let expectedOrigin = "";
    try {
      expectedOrigin = new URL(effective.url).origin;
    } catch {
      return;
    }
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin) return;
      const data = event.data;
      if (!data || typeof data !== "object" || data.kind !== "shellx-preview-doctor") return;
      const normalized = normalizePreviewBrowserEvent(data);
      recordWorkPreviewBrowserEvent(effective.tabId, normalized);
      if (isPreviewBrowserIssue(normalized)) {
        const issues = getWorkPreviewBrowserEvents(effective.tabId, {
          url: effective.url,
          sinceMs: effective.startedAtMs,
        }).filter(isPreviewBrowserIssue);
        setBrowserIssueCount(issues.length);
        setLastBrowserIssue(normalized);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [effective.url, effective.tabId]);

  async function openExternal(): Promise<void> {
    if (!effective.url) return;
    try {
      await invoke("open_url_in_browser", { url: effective.url });
    } catch {
      window.open(effective.url, "_blank", "noopener,noreferrer");
    }
  }

  async function copyUrl(): Promise<void> {
    if (!effective.url) return;
    try {
      await navigator.clipboard.writeText(effective.url);
    } catch {
      /* ignore */
    }
  }

  return (
        <div className="work-preview-stage">
          <div className="work-preview-stage-head">
            <div className="work-preview-stage-title">
              <ShellIcon name="app-window" size={14} />
              <span>Work Preview</span>
            </div>
            <div className="work-preview-stage-meta">
              <span>{workPreviewStatusLabel(effective.status)}</span>
              <span>{workPreviewKindLabel(effective.kind)}</span>
              {effective.cwd && <span title={effective.cwd}>{effective.cwd}</span>}
            </div>
            <div className="work-preview-stage-actions">
              {effective.url && (
                <div className="work-preview-device-toggle" role="tablist" aria-label="Preview viewport">
                  <button
                    type="button"
                    className={viewport === "phone" ? "active" : ""}
                    onClick={() => setViewport("phone")}
                    aria-selected={viewport === "phone"}
                    title="Phone viewport"
                  >
                    <ShellIcon name="phone" size={12} />
                  </button>
                  <button
                    type="button"
                    className={viewport === "tablet" ? "active" : ""}
                    onClick={() => setViewport("tablet")}
                    aria-selected={viewport === "tablet"}
                    title="Tablet viewport"
                  >
                    <ShellIcon name="tablet" size={12} />
                  </button>
                  <button
                    type="button"
                    className={viewport === "desktop" ? "active" : ""}
                    onClick={() => setViewport("desktop")}
                    aria-selected={viewport === "desktop"}
                    title="Desktop viewport"
                  >
                    <ShellIcon name="monitor" size={12} />
                  </button>
                </div>
              )}
              {effective.url && (
                <>
                  {browserIssueCount > 0 && onAskGrokToFix && (
                    <button
                      type="button"
                      className="settings-pill work-preview-error-pill"
                      onClick={() => onAskGrokToFix(effective)}
                      title={lastBrowserIssue?.message ?? "Preview browser issue captured"}
                    >
                      <ShellIcon name="alert" size={12} />
                      <span>{browserIssueCount}</span>
                    </button>
                  )}
                  {onAskGrokToFix && (
                    <button type="button" className="settings-pill" onClick={() => onAskGrokToFix(effective)} title="Run Preview Doctor and ask Grok to fix">
                      <ShellIcon name="alert" size={12} />
                    </button>
                  )}
                  <button type="button" className="settings-pill" onClick={() => setFrameReloadSeq((seq) => seq + 1)} title="Reload preview frame">
                    <ShellIcon name="refresh" size={12} />
                  </button>
                  <button type="button" className="settings-pill" onClick={() => void copyUrl()} title="Copy URL">
                    <ShellIcon name="copy" size={12} />
                  </button>
                  <button type="button" className="settings-pill" onClick={() => void openExternal()} title="Open externally">
                    <ShellIcon name="external-link" size={12} />
                  </button>
                </>
              )}
              {showClose && onClose && (
                <button type="button" className="settings-pill" onClick={onClose} title="Close">
                  <ShellIcon name="close" size={12} />
                </button>
              )}
            </div>
          </div>

          {hasUrl ? (
            <div className={`work-preview-stage-canvas work-preview-stage-canvas-${viewport}`}>
              <div className={`work-preview-device work-preview-device-${viewport}`}>
                <iframe
                  key={frameSrc}
                  className="work-preview-stage-frame"
                  title="Work preview"
                  src={frameSrc ?? undefined}
                  sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                />
              </div>
            </div>
          ) : (
            <div className="work-preview-stage-empty">
              <div className="rail-empty-line">
                {effective.status === "failed" ? "Preview failed." : "No preview running."}
              </div>
              <div className="rail-empty-hint">
                {effective.error
                  ? effective.error
                  : isRunning
                    ? "Preview is starting."
                    : "Start a static HTML, web, or Expo preview from the right rail."}
              </div>
            </div>
          )}
        </div>
  );
}

export function WorkPreviewModal({
  open,
  state,
  onClose,
  onAskGrokToFix,
}: {
  open: boolean;
  state: WorkPreviewState | null;
  onClose: () => void;
  onAskGrokToFix?: (state: WorkPreviewState) => void;
}): JSX.Element | null {
  if (!open) return null;
  return (
    <div className="work-preview-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Work Preview">
      <div className="work-preview-modal" onClick={(event) => event.stopPropagation()}>
        <WorkPreviewStage
          state={state}
          onClose={onClose}
          onAskGrokToFix={onAskGrokToFix}
        />
      </div>
    </div>
  );
}

function isPreviewBrowserIssue(event: WorkPreviewBrowserEvent): boolean {
  const level = event.level.toLowerCase();
  return level.includes("error") || level.includes("warn") || level === "exception";
}

function normalizePreviewBrowserEvent(data: Record<string, unknown>): WorkPreviewBrowserEvent {
  return {
    t: typeof data.t === "number" ? data.t : Date.now(),
    level: typeof data.level === "string" ? data.level : "error",
    message: typeof data.message === "string" ? data.message : String(data.message ?? ""),
    source: typeof data.source === "string" ? data.source : null,
    url: typeof data.url === "string" ? data.url : null,
    line: typeof data.line === "number" ? data.line : null,
    column: typeof data.column === "number" ? data.column : null,
    stack: typeof data.stack === "string" ? data.stack : null,
  };
}

function formatPreviewDoctorReport(diagnostic: WorkPreviewDiagnostic): string {
  const issues = diagnostic.issues.length > 0
    ? diagnostic.issues.map((issue) => `- ${issue.severity} ${issue.source}: ${issue.message}`).join("\n")
    : "- none";
  const browserEvents = diagnostic.browserEvents.length > 0
    ? diagnostic.browserEvents.slice(-20).map((event) => {
        const location = [event.url, event.line, event.column].filter((part) => part !== null && part !== undefined && part !== "").join(":");
        return `- ${event.level}: ${event.message}${location ? ` (${location})` : ""}`;
      }).join("\n")
    : "- none";
  const logs = diagnostic.logs.length > 0
    ? diagnostic.logs.slice(-80).map((line) => `[${line.stream}] ${line.line}`).join("\n")
    : "(no logs)";

  return [
    "shellX Preview Doctor report",
    "",
    `Status: ${diagnostic.status}`,
    `Summary: ${diagnostic.summary}`,
    `URL: ${diagnostic.url ?? "(none)"}`,
    `CWD: ${diagnostic.cwd ?? "(none)"}`,
    `Command: ${diagnostic.command ?? "(none)"}`,
    `HTTP: ${diagnostic.httpStatus ?? "(none)"}`,
    `Title: ${diagnostic.title ?? "(none)"}`,
    `Screenshot: ${diagnostic.screenshotPath ?? diagnostic.screenshotError ?? "(none)"}`,
    "",
    "Issues:",
    issues,
    "",
    "Browser events:",
    browserEvents,
    "",
    "Recent logs:",
    "```text",
    logs,
    "```",
  ].join("\n");
}

function cacheBustPreviewUrl(url: string, updatedAtMs: number, reloadSeq: number): string {
  try {
    const next = new URL(url);
    next.searchParams.set("__shellx_preview", `${updatedAtMs}-${reloadSeq}`);
    return next.toString();
  } catch {
    const joiner = url.includes("?") ? "&" : "?";
    return `${url}${joiner}__shellx_preview=${encodeURIComponent(`${updatedAtMs}-${reloadSeq}`)}`;
  }
}
