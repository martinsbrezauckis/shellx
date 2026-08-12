import { lazy, Suspense, useEffect, useRef, type FormEvent, type JSX, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";

import type { VaultApprovalPrompt } from "../../lib/vault-approval-prompts";
import type { ShellIconName } from "../../components/icons";
import { ShellIcon } from "../../components/icons";
import type { BrowserConsoleLog, BrowserReceipt, BrowserTask, BrowserTransferEntry } from "../types";
import type { BrowserCoworkMessage } from "../browserCowork";
import { VaultPromptCards } from "./VaultPromptCards";

const BrowserEvidencePanel = lazy(async () => {
  const module = await import("./BrowserEvidencePanel");
  return { default: module.BrowserEvidencePanel };
});

export type AgentSidebarPanelId = "chat" | "requests" | "actions" | "evidence" | "errors";
export type AgentSidebarSectionId = "tasks" | "console" | "receipts";

const AGENT_SIDEBAR_PANEL_ORDER: AgentSidebarPanelId[] = [
  "chat",
  "requests",
  "actions",
  "evidence",
  "errors",
];

function agentSidebarTabId(panel: AgentSidebarPanelId): string {
  return `shellx-browser-right-tab-${panel}`;
}

interface AgentSidebarProps {
  show: boolean;
  rightSidebarWidth: number;
  rightPanelTab: AgentSidebarPanelId;
  goal: string;
  busy: boolean;
  taskControlBusy: boolean;
  activeTask: BrowserTask | null;
  browserChatMessages: BrowserCoworkMessage[];
  coworkSessionLabel: string;
  canSendCoworkMessage: boolean;
  vaultPromptSummary: string;
  vaultPrompts: VaultApprovalPrompt[];
  tasks: BrowserTask[];
  receipts: BrowserReceipt[];
  downloads: BrowserTransferEntry[];
  uploads: BrowserTransferEntry[];
  consoleLogs: BrowserConsoleLog[];
  collapsedSections: Record<AgentSidebarSectionId, boolean>;
  formatReceiptTime: (t: number) => string;
  formatLogLocation: (log: BrowserConsoleLog) => string;
  browserLogLevelClass: (level: string) => string;
  vaultPromptIcon: (prompt: VaultApprovalPrompt) => ShellIconName;
  vaultPromptDebugSuffix: (prompt: VaultApprovalPrompt) => string;
  canExplainPage: boolean;
  onResizeStart: (event: PointerEvent<HTMLButtonElement>) => void;
  onResizeKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onHideRightSidebar: () => void;
  onSelectRightPanelTab: (tab: AgentSidebarPanelId) => void;
  onGoalChange: (goal: string) => void;
  onSubmitTask: (event: FormEvent<HTMLFormElement>) => void;
  onSubmitTaskFromKeyboard: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onControlTask: (
    action: "pause" | "resume" | "abort" | "userTakeover",
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
  onFinishTask: (status: "completed" | "blocked", event: MouseEvent<HTMLButtonElement>) => void;
  onToggleSection: (section: AgentSidebarSectionId) => void;
  onExplainPage: (event: MouseEvent<HTMLButtonElement>) => void;
  onVaultPromptAction: (
    prompt: VaultApprovalPrompt,
    actionKind?: string,
    event?: MouseEvent<HTMLButtonElement>,
  ) => void;
}

export function AgentSidebar({
  show,
  rightSidebarWidth,
  rightPanelTab,
  goal,
  busy,
  taskControlBusy,
  activeTask,
  browserChatMessages,
  coworkSessionLabel,
  canSendCoworkMessage,
  vaultPromptSummary,
  vaultPrompts,
  tasks,
  receipts,
  downloads,
  uploads,
  consoleLogs,
  collapsedSections,
  formatReceiptTime,
  formatLogLocation,
  browserLogLevelClass,
  vaultPromptIcon,
  vaultPromptDebugSuffix,
  canExplainPage,
  onResizeStart,
  onResizeKeyDown,
  onHideRightSidebar,
  onSelectRightPanelTab,
  onGoalChange,
  onSubmitTask,
  onSubmitTaskFromKeyboard,
  onControlTask,
  onFinishTask,
  onToggleSection,
  onExplainPage,
  onVaultPromptAction,
}: AgentSidebarProps): JSX.Element | null {
  const chatStreamRef = useRef<HTMLDivElement | null>(null);
  const autoScrollChatRef = useRef(true);
  useEffect(() => {
    const stream = chatStreamRef.current;
    if (stream && autoScrollChatRef.current) stream.scrollTop = stream.scrollHeight;
  }, [browserChatMessages, show]);
  if (!show) return null;

  const isSectionOpen = (section: AgentSidebarSectionId) => !collapsedSections[section];
  const requestCount = vaultPrompts.length;
  const requestBadge = requestCount > 9 ? "9+" : requestCount > 0 ? String(requestCount) : "";
  const recentTasks = tasks.slice().reverse().slice(0, 1);
  const recentTransfers = [...downloads, ...uploads].slice().reverse().slice(0, 1);
  const recentReceipts = receipts.slice().reverse().slice(0, 4);
  const handlePanelTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    panel: AgentSidebarPanelId,
  ) => {
    const currentIndex = AGENT_SIDEBAR_PANEL_ORDER.indexOf(panel);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % AGENT_SIDEBAR_PANEL_ORDER.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + AGENT_SIDEBAR_PANEL_ORDER.length) % AGENT_SIDEBAR_PANEL_ORDER.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = AGENT_SIDEBAR_PANEL_ORDER.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const nextPanel = AGENT_SIDEBAR_PANEL_ORDER[nextIndex] ?? panel;
    onSelectRightPanelTab(nextPanel);
    document.getElementById(agentSidebarTabId(nextPanel))?.focus();
  };

  return (
    <aside className="shellx-browser-sidebar shellx-browser-right">
      <button
        type="button"
        className="shellx-browser-sidebar-resize"
        onPointerDown={onResizeStart}
        onKeyDown={onResizeKeyDown}
        data-debug-id="shellx-browser-sidebar-resize"
        data-shellx-release-observe="title"
        title={`Resize right panel · width=${rightSidebarWidth}px · use Left/Right arrows`}
        aria-label="Resize right panel with Left and Right arrow keys"
      />
      <div className="shellx-browser-right-controls">
        <button
          type="button"
          className="shellx-browser-panel-toggle shellx-browser-panel-toggle-right"
          onClick={onHideRightSidebar}
          data-debug-id="shellx-browser-toggle-right-sidebar-button"
          title="Hide right panel"
          aria-label="Hide right panel"
          data-shellx-release-observe="title"
        >
          <ShellIcon name="chevrons-right" size={14} />
        </button>
        <div className="shellx-browser-vault-prompt" data-debug-id="shellx-browser-vault-prompt">
          {vaultPromptSummary}
        </div>
      </div>
      <div className="shellx-browser-right-tabs" role="tablist" aria-label="Browser right panel" aria-orientation="horizontal">
        <button
          type="button"
          id="shellx-browser-right-tab-chat"
          role="tab"
          aria-selected={rightPanelTab === "chat"}
          aria-controls="shellx-browser-panel-chat"
          tabIndex={rightPanelTab === "chat" ? 0 : -1}
          className={rightPanelTab === "chat" ? "active" : ""}
          onClick={() => onSelectRightPanelTab("chat")}
          onKeyDown={(event) => handlePanelTabKeyDown(event, "chat")}
          data-debug-id="shellx-browser-right-tab-chat"
          data-shellx-release-observe="selected"
        >
          Chat
        </button>
        <button
          type="button"
          id="shellx-browser-right-tab-requests"
          role="tab"
          aria-selected={rightPanelTab === "requests"}
          aria-controls="shellx-browser-panel-requests"
          tabIndex={rightPanelTab === "requests" ? 0 : -1}
          className={rightPanelTab === "requests" ? "active" : ""}
          onClick={() => onSelectRightPanelTab("requests")}
          onKeyDown={(event) => handlePanelTabKeyDown(event, "requests")}
          data-debug-id="shellx-browser-right-tab-requests"
          data-shellx-release-observe="selected"
        >
          <span>Requests</span>
          {requestBadge && <span className="shellx-browser-tab-badge">{requestBadge}</span>}
        </button>
        <button
          type="button"
          id="shellx-browser-right-tab-actions"
          role="tab"
          aria-selected={rightPanelTab === "actions"}
          aria-controls="shellx-browser-panel-actions"
          tabIndex={rightPanelTab === "actions" ? 0 : -1}
          className={rightPanelTab === "actions" ? "active" : ""}
          onClick={() => onSelectRightPanelTab("actions")}
          onKeyDown={(event) => handlePanelTabKeyDown(event, "actions")}
          data-debug-id="shellx-browser-right-tab-actions"
          data-shellx-release-observe="selected"
        >
          Actions
        </button>
        <button
          type="button"
          id="shellx-browser-right-tab-evidence"
          role="tab"
          aria-selected={rightPanelTab === "evidence"}
          aria-controls="shellx-browser-panel-evidence"
          tabIndex={rightPanelTab === "evidence" ? 0 : -1}
          className={rightPanelTab === "evidence" ? "active" : ""}
          onClick={() => onSelectRightPanelTab("evidence")}
          onKeyDown={(event) => handlePanelTabKeyDown(event, "evidence")}
          data-debug-id="shellx-browser-right-tab-evidence"
          data-shellx-release-observe="selected"
        >
          Evidence
        </button>
        <button
          type="button"
          id="shellx-browser-right-tab-errors"
          role="tab"
          aria-selected={rightPanelTab === "errors"}
          aria-controls="shellx-browser-panel-errors"
          tabIndex={rightPanelTab === "errors" ? 0 : -1}
          className={rightPanelTab === "errors" ? "active" : ""}
          onClick={() => onSelectRightPanelTab("errors")}
          onKeyDown={(event) => handlePanelTabKeyDown(event, "errors")}
          data-debug-id="shellx-browser-right-tab-errors"
          data-shellx-release-observe="selected"
        >
          Errors
        </button>
      </div>

      {rightPanelTab === "chat" && (
        <section
          id="shellx-browser-panel-chat"
          role="tabpanel"
          aria-labelledby="shellx-browser-right-tab-chat"
          className="shellx-browser-agent-panel chat-expanded"
          data-debug-id="shellx-browser-agent-panel"
        >
          <div
            ref={chatStreamRef}
            className="shellx-browser-agent-chat-stream"
            data-debug-id="shellx-browser-agent-chat-stream"
            onScroll={(event) => {
              const stream = event.currentTarget;
              autoScrollChatRef.current = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 48;
            }}
          >
            <div className="shellx-browser-chat-bubble system" data-debug-id="shellx-browser-cowork-session">
              <span>Attached session</span>
              <p>{coworkSessionLabel}</p>
            </div>
            {browserChatMessages.map((message) => (
              <div key={message.id} className={`shellx-browser-chat-bubble ${message.role}`}>
                <span>{message.label}</span>
                <p>{message.text}</p>
              </div>
            ))}
          </div>
          <form className="shellx-browser-agent-compose" onSubmit={onSubmitTask}>
            <div className="shellx-browser-agent-quick-actions" data-debug-id="shellx-browser-agent-quick-actions">
              <button
                type="button"
                className="shellx-browser-secondary"
                onClick={onExplainPage}
                disabled={busy || !canExplainPage || !canSendCoworkMessage}
                data-debug-id="shellx-browser-chat-explain-page"
                title={!canSendCoworkMessage ? "Open or choose a ShellX agent tab first" : canExplainPage ? "Ask the Browser agent to explain this page" : "Open a page before asking the Browser agent to explain it"}
              >
                <ShellIcon name="sparkles" size={13} />
                Explain page
              </button>
            </div>
            <label className="shellx-browser-goal">
              <span>Message</span>
              <textarea
                value={goal}
                onChange={(event) => onGoalChange(event.target.value)}
                onKeyDown={onSubmitTaskFromKeyboard}
                data-debug-id="shellx-browser-goal"
                data-shellx-release-observe="value"
                rows={4}
              />
            </label>
            <div className="shellx-browser-agent-controls">
              <button
                type="submit"
                className="shellx-browser-primary"
                disabled={busy || !goal.trim() || !canSendCoworkMessage}
                data-debug-id="shellx-browser-agent-send"
                title={canSendCoworkMessage ? `Send to ${coworkSessionLabel}` : "Open or choose a ShellX agent tab first"}
              >
                <ShellIcon name="send" size={14} />
                Send
              </button>
              <button
                type="button"
                className="shellx-browser-secondary"
                onClick={(event) => onControlTask("pause", event)}
                disabled={!activeTask || activeTask.status === "paused" || taskControlBusy}
                data-debug-id="shellx-browser-agent-pause"
                data-shellx-release-observe="disabled"
                title="Pause"
              >
                <ShellIcon name="pause" size={13} />
                Pause
              </button>
              <button
                type="button"
                className="shellx-browser-secondary"
                onClick={(event) => onControlTask("resume", event)}
                disabled={!activeTask || activeTask.status === "running" || taskControlBusy}
                data-debug-id="shellx-browser-agent-resume"
                data-shellx-release-observe="disabled"
                title="Resume"
              >
                <ShellIcon name="play" size={13} />
                Resume
              </button>
              <button
                type="button"
                className="shellx-browser-secondary"
                onClick={(event) => onControlTask("userTakeover", event)}
                disabled={!activeTask || activeTask.status === "userTakeover" || taskControlBusy}
                data-debug-id="shellx-browser-agent-takeover"
                data-shellx-release-observe="disabled"
                title="User takeover"
              >
                <ShellIcon name="user" size={13} />
                Takeover
              </button>
              <button
                type="button"
                className="shellx-browser-secondary"
                onClick={(event) => onControlTask("abort", event)}
                disabled={!activeTask || activeTask.status === "aborted" || taskControlBusy}
                data-debug-id="shellx-browser-agent-abort"
                data-shellx-release-observe="disabled"
                title="Abort task"
              >
                <ShellIcon name="ban" size={13} />
                Abort task
              </button>
            </div>
          </form>
        </section>
      )}

      {rightPanelTab === "requests" && (
        <section id="shellx-browser-panel-requests" role="tabpanel" aria-labelledby="shellx-browser-right-tab-requests" className="shellx-browser-requests-panel shellx-browser-scroll-panel" data-debug-id="shellx-browser-requests-panel">
          <VaultPromptCards
            prompts={vaultPrompts}
            busy={busy}
            getIconName={vaultPromptIcon}
            getDebugSuffix={vaultPromptDebugSuffix}
            onAction={onVaultPromptAction}
          />
          {vaultPrompts.length === 0 && (
            <div className="shellx-browser-empty-state" data-debug-id="shellx-browser-requests-empty">
              No browser Vault requests.
            </div>
          )}
        </section>
      )}

      {rightPanelTab === "actions" && (
        <section id="shellx-browser-panel-actions" role="tabpanel" aria-labelledby="shellx-browser-right-tab-actions" className="shellx-browser-actions-panel shellx-browser-scroll-panel" data-debug-id="shellx-browser-actions-panel">
          <button
            type="button"
            id="shellx-browser-collapse-tasks"
            className="shellx-browser-section-heading"
            onClick={() => onToggleSection("tasks")}
            data-debug-id="shellx-browser-collapse-tasks"
            aria-expanded={isSectionOpen("tasks")}
            aria-controls="shellx-browser-actions-tasks-section"
          >
            <ShellIcon name={isSectionOpen("tasks") ? "chevron-down" : "chevron-right"} size={12} />
            <span>Tasks</span>
          </button>
          {isSectionOpen("tasks") && (
            <div
              id="shellx-browser-actions-tasks-section"
              role="region"
              aria-labelledby="shellx-browser-collapse-tasks"
            >
              <div className="shellx-browser-agent-controls">
              <button
                type="button"
                className="shellx-browser-secondary"
                onClick={(event) => onFinishTask("completed", event)}
                disabled={!activeTask || taskControlBusy}
                data-debug-id="shellx-browser-complete"
                data-shellx-release-observe="disabled"
              >
                Complete
              </button>
              <button
                type="button"
                className="shellx-browser-secondary"
                onClick={(event) => onFinishTask("blocked", event)}
                disabled={!activeTask || taskControlBusy}
                data-debug-id="shellx-browser-block"
                data-shellx-release-observe="disabled"
              >
                Block
              </button>
              </div>
              {recentTasks.map((task) => (
                <div
                  key={task.taskId}
                  className={`shellx-browser-list-row ${task.taskId === activeTask?.taskId ? "active" : ""}`}
                  data-debug-id={`shellx-browser-task-${task.taskId}`}
                  aria-current={task.taskId === activeTask?.taskId ? "true" : undefined}
                >
                  <span>{task.goal}</span>
                  <small>{task.status}</small>
                </div>
              ))}
              {tasks.length > recentTasks.length && (
                <div className="shellx-browser-empty-log">{tasks.length - recentTasks.length} older tasks hidden</div>
              )}
              {tasks.length === 0 && (
                <div className="shellx-browser-empty-state">No browser tasks yet</div>
              )}
            </div>
          )}

          <section className="shellx-browser-transfer-list" data-debug-id="shellx-browser-downloads">
            <div
              className="shellx-browser-section-heading static"
              aria-label="Transfer history"
            >
              <ShellIcon name="file" size={12} />
              <span>Transfers</span>
            </div>
            {recentTransfers.map((entry) => (
              <div key={entry.transferId} className="shellx-browser-transfer">
                <span>{entry.direction}</span>
                <p>{entry.displayName || entry.url || entry.filePath || entry.transferId}</p>
                <small>{entry.status} · {entry.reason}</small>
              </div>
            ))}
            {downloads.length + uploads.length > recentTransfers.length && (
              <div className="shellx-browser-empty-log">{downloads.length + uploads.length - recentTransfers.length} older transfers hidden</div>
            )}
            {downloads.length + uploads.length === 0 && (
              <div className="shellx-browser-empty-log">No transfer intents</div>
            )}
          </section>

          <section>
            <button
              type="button"
              id="shellx-browser-collapse-receipts"
              className="shellx-browser-section-heading"
              onClick={() => onToggleSection("receipts")}
              data-debug-id="shellx-browser-collapse-receipts"
              aria-expanded={isSectionOpen("receipts")}
              aria-controls="shellx-browser-actions-receipts-section"
            >
              <ShellIcon name={isSectionOpen("receipts") ? "chevron-down" : "chevron-right"} size={12} />
              <span>Receipts</span>
            </button>
            {isSectionOpen("receipts") && (
              <div
                id="shellx-browser-actions-receipts-section"
                role="region"
                aria-labelledby="shellx-browser-collapse-receipts"
              >
                {recentReceipts.map((receipt) => (
                  <div key={receipt.receiptId} className="shellx-browser-receipt">
                    <span>{receipt.kind}</span>
                    <small>{formatReceiptTime(receipt.t)} · {receipt.summary}</small>
                  </div>
                ))}
                {receipts.length > recentReceipts.length && (
                  <div className="shellx-browser-empty-log">{receipts.length - recentReceipts.length} older receipts hidden</div>
                )}
                {receipts.length === 0 && (
                  <div className="shellx-browser-empty-state">No receipts yet</div>
                )}
              </div>
            )}
          </section>
        </section>
      )}

      {rightPanelTab === "evidence" && (
        <Suspense
          fallback={(
            <section
              id="shellx-browser-panel-evidence"
              role="tabpanel"
              aria-labelledby="shellx-browser-right-tab-evidence"
              className="shellx-browser-evidence-panel shellx-browser-scroll-panel"
              aria-busy="true"
            >
              <div className="shellx-browser-empty-state">Loading Evidence…</div>
            </section>
          )}
        >
          <BrowserEvidencePanel open activeTaskId={activeTask?.taskId} />
        </Suspense>
      )}

      {rightPanelTab === "errors" && (
        <section id="shellx-browser-panel-errors" role="tabpanel" aria-labelledby="shellx-browser-right-tab-errors" className="shellx-browser-console shellx-browser-scroll-panel" data-debug-id="shellx-browser-console">
          <button
            type="button"
            id="shellx-browser-collapse-console"
            className="shellx-browser-section-heading"
            onClick={() => onToggleSection("console")}
            data-debug-id="shellx-browser-collapse-console"
            aria-expanded={isSectionOpen("console")}
            aria-controls="shellx-browser-errors-console-section"
          >
            <ShellIcon name={isSectionOpen("console") ? "chevron-down" : "chevron-right"} size={12} />
            <span>Page errors</span>
          </button>
          {isSectionOpen("console") && (
            <div
              id="shellx-browser-errors-console-section"
              role="region"
              aria-labelledby="shellx-browser-collapse-console"
            >
              {consoleLogs.slice().reverse().slice(0, 12).map((log) => (
                <div key={log.logId} className={`shellx-browser-log ${browserLogLevelClass(log.level)}`}>
                  <span>{log.level}</span>
                  <p>{log.message}</p>
                  <small>{formatReceiptTime(log.t)} · {formatLogLocation(log)}</small>
                </div>
              ))}
              {consoleLogs.length === 0 && (
                <div className="shellx-browser-empty-log">No page errors recorded</div>
              )}
            </div>
          )}
        </section>
      )}
    </aside>
  );
}
