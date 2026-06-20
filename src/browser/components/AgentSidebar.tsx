import type { FormEvent, JSX, KeyboardEvent, MouseEvent, PointerEvent } from "react";

import type { VaultApprovalPrompt } from "../../lib/vault-approval-prompts";
import type { ShellIconName } from "../../components/icons";
import { ShellIcon } from "../../components/icons";
import type { BrowserAutonomy, BrowserConsoleLog, BrowserReceipt, BrowserTask, BrowserTransferEntry } from "../types";
import { VaultPromptCards } from "./VaultPromptCards";

export type AgentSidebarPanelId = "chat" | "requests" | "actions" | "errors";
export type AgentSidebarSectionId = "tasks" | "console" | "receipts";

interface BrowserChatMessage {
  id: string;
  role: "system" | "user" | "assistant";
  label: string;
  text: string;
}

interface AgentSidebarProps {
  show: boolean;
  rightPanelTab: AgentSidebarPanelId;
  autonomy: BrowserAutonomy;
  goal: string;
  busy: boolean;
  activeTask: BrowserTask | null;
  browserChatMessages: BrowserChatMessage[];
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
  onResizeStart: (event: PointerEvent<HTMLButtonElement>) => void;
  onHideRightSidebar: () => void;
  onSelectRightPanelTab: (tab: AgentSidebarPanelId) => void;
  onAutonomyChange: (autonomy: BrowserAutonomy) => void;
  onGoalChange: (goal: string) => void;
  onSubmitTask: (event: FormEvent<HTMLFormElement>) => void;
  onSubmitTaskFromKeyboard: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onControlTask: (action: "pause" | "resume" | "abort" | "userTakeover") => void;
  onFinishTask: (status: "completed" | "blocked") => void;
  onToggleSection: (section: AgentSidebarSectionId) => void;
  onVaultPromptAction: (
    prompt: VaultApprovalPrompt,
    actionKind?: string,
    event?: MouseEvent<HTMLButtonElement>,
  ) => void;
}

export function AgentSidebar({
  show,
  rightPanelTab,
  autonomy,
  goal,
  busy,
  activeTask,
  browserChatMessages,
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
  onResizeStart,
  onHideRightSidebar,
  onSelectRightPanelTab,
  onAutonomyChange,
  onGoalChange,
  onSubmitTask,
  onSubmitTaskFromKeyboard,
  onControlTask,
  onFinishTask,
  onToggleSection,
  onVaultPromptAction,
}: AgentSidebarProps): JSX.Element | null {
  if (!show) return null;

  const isSectionOpen = (section: AgentSidebarSectionId) => !collapsedSections[section];
  const requestCount = vaultPrompts.length;
  const requestBadge = requestCount > 9 ? "9+" : requestCount > 0 ? String(requestCount) : "";
  const recentTasks = tasks.slice().reverse().slice(0, 1);
  const recentTransfers = [...downloads, ...uploads].slice().reverse().slice(0, 1);
  const recentReceipts = receipts.slice().reverse().slice(0, 4);

  return (
    <aside className="shellx-browser-sidebar shellx-browser-right">
      <button
        type="button"
        className="shellx-browser-sidebar-resize"
        onPointerDown={onResizeStart}
        data-debug-id="shellx-browser-sidebar-resize"
        title="Resize right panel"
        aria-label="Resize right panel"
      />
      <div className="shellx-browser-right-controls">
        <button
          type="button"
          className="shellx-browser-panel-toggle shellx-browser-panel-toggle-right"
          onClick={onHideRightSidebar}
          data-debug-id="shellx-browser-toggle-right-sidebar-button"
          title="Hide right panel"
        >
          <ShellIcon name="chevrons-right" size={14} />
        </button>
        <label className="shellx-browser-sidebar-autonomy">
          <span>Autonomy</span>
          <select
            value={autonomy}
            onChange={(event) => onAutonomyChange(event.target.value as BrowserAutonomy)}
            data-debug-id="shellx-browser-autonomy"
          >
            <option value="approvalFirst">Approval first</option>
            <option value="assistedAutonomous">Assisted autonomous</option>
            <option value="autonomous">Autonomous</option>
            <option value="unattendedWithPolicy">Unattended policy</option>
          </select>
        </label>
        <div className="shellx-browser-vault-prompt" data-debug-id="shellx-browser-vault-prompt">
          {vaultPromptSummary}
        </div>
      </div>
      <div className="shellx-browser-right-tabs" role="tablist" aria-label="Browser right panel">
        <button
          type="button"
          className={rightPanelTab === "chat" ? "active" : ""}
          onClick={() => onSelectRightPanelTab("chat")}
          data-debug-id="shellx-browser-right-tab-chat"
        >
          Chat
        </button>
        <button
          type="button"
          className={rightPanelTab === "requests" ? "active" : ""}
          onClick={() => onSelectRightPanelTab("requests")}
          data-debug-id="shellx-browser-right-tab-requests"
        >
          <span>Requests</span>
          {requestBadge && <span className="shellx-browser-tab-badge">{requestBadge}</span>}
        </button>
        <button
          type="button"
          className={rightPanelTab === "actions" ? "active" : ""}
          onClick={() => onSelectRightPanelTab("actions")}
          data-debug-id="shellx-browser-right-tab-actions"
        >
          Actions
        </button>
        <button
          type="button"
          className={rightPanelTab === "errors" ? "active" : ""}
          onClick={() => onSelectRightPanelTab("errors")}
          data-debug-id="shellx-browser-right-tab-errors"
        >
          Errors
        </button>
      </div>

      {rightPanelTab === "chat" && (
        <section
          className="shellx-browser-agent-panel chat-expanded"
          data-debug-id="shellx-browser-agent-panel"
        >
          <div className="shellx-browser-agent-chat-stream" data-debug-id="shellx-browser-agent-chat-stream">
            {browserChatMessages.map((message) => (
              <div key={message.id} className={`shellx-browser-chat-bubble ${message.role}`}>
                <span>{message.label}</span>
                <p>{message.text}</p>
              </div>
            ))}
          </div>
          <form className="shellx-browser-agent-compose" onSubmit={onSubmitTask}>
            <label className="shellx-browser-goal">
              <span>Message</span>
              <textarea
                value={goal}
                onChange={(event) => onGoalChange(event.target.value)}
                onKeyDown={onSubmitTaskFromKeyboard}
                data-debug-id="shellx-browser-goal"
                rows={4}
              />
            </label>
            <div className="shellx-browser-agent-controls">
              <button
                type="submit"
                className="shellx-browser-primary"
                disabled={busy || !goal.trim()}
                data-debug-id="shellx-browser-agent-send"
                title="Send"
              >
                <ShellIcon name="send" size={14} />
                Send
              </button>
              <button
                type="button"
                className="shellx-browser-secondary"
                onClick={() => onControlTask("pause")}
                disabled={!activeTask || activeTask.status === "paused" || busy}
                data-debug-id="shellx-browser-agent-pause"
                title="Pause"
              >
                <ShellIcon name="pause" size={13} />
                Pause
              </button>
              <button
                type="button"
                className="shellx-browser-secondary"
                onClick={() => onControlTask("resume")}
                disabled={!activeTask || activeTask.status === "running" || busy}
                data-debug-id="shellx-browser-agent-resume"
                title="Resume"
              >
                <ShellIcon name="play" size={13} />
                Resume
              </button>
              <button
                type="button"
                className="shellx-browser-secondary"
                onClick={() => onControlTask("userTakeover")}
                disabled={!activeTask || activeTask.status === "userTakeover" || busy}
                data-debug-id="shellx-browser-agent-takeover"
                title="User takeover"
              >
                <ShellIcon name="user" size={13} />
                Takeover
              </button>
              <button
                type="button"
                className="shellx-browser-secondary"
                onClick={() => onControlTask("abort")}
                disabled={!activeTask || activeTask.status === "aborted" || busy}
                data-debug-id="shellx-browser-agent-abort"
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
        <section className="shellx-browser-requests-panel shellx-browser-scroll-panel" data-debug-id="shellx-browser-requests-panel">
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
        <section className="shellx-browser-actions-panel shellx-browser-scroll-panel" data-debug-id="shellx-browser-actions-panel">
          <button
            type="button"
            className="shellx-browser-section-heading"
            onClick={() => onToggleSection("tasks")}
            data-debug-id="shellx-browser-collapse-tasks"
            aria-expanded={isSectionOpen("tasks")}
          >
            <ShellIcon name={isSectionOpen("tasks") ? "chevron-down" : "chevron-right"} size={12} />
            <span>Tasks</span>
          </button>
          {isSectionOpen("tasks") && (
            <div className="shellx-browser-agent-controls">
              <button
                type="button"
                className="shellx-browser-secondary"
                onClick={() => onFinishTask("completed")}
                disabled={!activeTask || busy}
                data-debug-id="shellx-browser-complete"
              >
                Complete
              </button>
              <button
                type="button"
                className="shellx-browser-secondary"
                onClick={() => onFinishTask("blocked")}
                disabled={!activeTask || busy}
                data-debug-id="shellx-browser-block"
              >
                Block
              </button>
            </div>
          )}
          {isSectionOpen("tasks") && recentTasks.map((task) => (
            <button
              key={task.taskId}
              type="button"
              className={`shellx-browser-list-row ${task.taskId === activeTask?.taskId ? "active" : ""}`}
              data-debug-id={`shellx-browser-task-${task.taskId}`}
            >
              <span>{task.goal}</span>
              <small>{task.status}</small>
            </button>
          ))}
          {isSectionOpen("tasks") && tasks.length > recentTasks.length && (
            <div className="shellx-browser-empty-log">{tasks.length - recentTasks.length} older tasks hidden</div>
          )}
          {isSectionOpen("tasks") && tasks.length === 0 && (
            <div className="shellx-browser-empty-state">No browser tasks yet</div>
          )}

          <section className="shellx-browser-transfer-list" data-debug-id="shellx-browser-downloads">
            <button
              type="button"
              className="shellx-browser-section-heading"
              onClick={() => undefined}
              aria-expanded="true"
            >
              <ShellIcon name="file" size={12} />
              <span>Transfers</span>
            </button>
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
              className="shellx-browser-section-heading"
              onClick={() => onToggleSection("receipts")}
              data-debug-id="shellx-browser-collapse-receipts"
              aria-expanded={isSectionOpen("receipts")}
            >
              <ShellIcon name={isSectionOpen("receipts") ? "chevron-down" : "chevron-right"} size={12} />
              <span>Receipts</span>
            </button>
            {isSectionOpen("receipts") && recentReceipts.map((receipt) => (
              <div key={receipt.receiptId} className="shellx-browser-receipt">
                <span>{receipt.kind}</span>
                <small>{formatReceiptTime(receipt.t)} · {receipt.summary}</small>
              </div>
            ))}
            {isSectionOpen("receipts") && receipts.length > recentReceipts.length && (
              <div className="shellx-browser-empty-log">{receipts.length - recentReceipts.length} older receipts hidden</div>
            )}
            {isSectionOpen("receipts") && receipts.length === 0 && (
              <div className="shellx-browser-empty-state">No receipts yet</div>
            )}
          </section>
        </section>
      )}

      {rightPanelTab === "errors" && (
        <section className="shellx-browser-console shellx-browser-scroll-panel" data-debug-id="shellx-browser-console">
          <button
            type="button"
            className="shellx-browser-section-heading"
            onClick={() => onToggleSection("console")}
            data-debug-id="shellx-browser-collapse-console"
            aria-expanded={isSectionOpen("console")}
          >
            <ShellIcon name={isSectionOpen("console") ? "chevron-down" : "chevron-right"} size={12} />
            <span>Page errors</span>
          </button>
          {isSectionOpen("console") && consoleLogs.slice().reverse().slice(0, 12).map((log) => (
            <div key={log.logId} className={`shellx-browser-log ${browserLogLevelClass(log.level)}`}>
              <span>{log.level}</span>
              <p>{log.message}</p>
              <small>{formatReceiptTime(log.t)} · {formatLogLocation(log)}</small>
            </div>
          ))}
          {isSectionOpen("console") && consoleLogs.length === 0 && (
            <div className="shellx-browser-empty-log">No page errors recorded</div>
          )}
        </section>
      )}
    </aside>
  );
}
