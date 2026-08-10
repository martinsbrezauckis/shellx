/**
 * src/components/PermissionPill.tsx — issue #374.
 *
 * In-chat surface for ACP `session/request_permission` requests. Renders as
 * a chat row inserted into `ChatOutput` via the `PermissionGroup` UiGroup.
 *
 * Two visual states:
 * • PENDING — two-line layout: header (tool name + args preview) +
 * button row with [✓ Allow] [✓✓ Allow always] [✗ Deny]. Click posts
 * the decision via the existing `resolve_permission_request` Tauri
 * command, then optimistically dispatches a synthetic
 * `permission-resolved` event that `grouping.ts` reconciles into a
 * resolved PermissionGroup. The Rust handler is the source of truth;
 * the synthetic event is purely a UI bridge so the pill flips state
 * without waiting for a re-emit.
 * • RESOLVED — one-line audit chip with a green ✓ / red ✗ marker.
 * Renders for both user-decided (post-click) and auto-decided
 * (bypassPermissions / plan mode) paths, which is the audit-trail
 * half of the feature.
 *
 * RTL-safe layout: uses CSS flex for all positioning. No `position:
 * absolute` or `right:` offsets, so the chip flips cleanly under
 * `dir="rtl"` without special-casing.
 *
 * Resolution path:
 * 1. User clicks Allow → invoke("resolve_permission_request",
 * { requestId, allow: true }).
 * 2. Pill dispatches `window.dispatchEvent(new CustomEvent("shellx:
 * synthetic-event", { detail: { kind: "permission-resolved",
 * payload: { requestId, decision: "allow", _meta: { tabId } } } }))`.
 * 3. App.tsx's existing synthetic-event listener (added alongside this
 * component) appends the event to the events ring. The next
 * `groupEvents` run mutates the matching PermissionGroup to
 * pending:false + decision:"allow" + decisionAt:Date.now.
 *
 * The command also receives the exact UI decision. Grok keeps its existing
 * ACP option-selection behavior, while provider-native drivers can preserve
 * Allow once versus Allow always in their own response vocabulary.
 */
import { useCallback, useState, type JSX, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PermissionGroup } from "../lib/grouping";
import { ShellIcon } from "./icons";
import { isTrustedShellxUserEvent } from "../lib/trusted-user-event";
import {
  DEBUG_PERMISSION_DECISION_FIXTURE,
  DEBUG_PERMISSION_FIXTURE_META_KEY,
  type DebugPermissionDecisionFixture,
} from "../lib/debug-permission-decision-fixture";

interface Props {
  g: PermissionGroup;
 /** Active tab id so the synthetic event carries `_meta.tabId` and
 * routes to the correct chat view in multi-tab installs. */
  tabId?: string;
  debugFixture?: DebugPermissionDecisionFixture | null;
}

/** Post a synthetic event into the events ring. App.tsx subscribes to
 * the `shellx:synthetic-event` window event and forwards into setEvents
 * so eventsForActiveTab + groupEvents pick it up on the next render. */
function dispatchSynthetic(
  kind: string,
  payload: Record<string, unknown>,
  tabId: string | undefined,
): void {
  const tagged = {
    ...payload,
    _meta: { ...(payload as any)._meta, tabId: tabId ?? "default" },
  };
  window.dispatchEvent(
    new CustomEvent("shellx:synthetic-event", {
      detail: { kind, payload: tagged },
    }),
  );
}

export function PermissionPill({ g, tabId, debugFixture = null }: Props): JSX.Element {
 /* Optimistic local state — set as soon as the user clicks, even
 * before the synthetic-event round-trip mutates the group. Without
 * this the button row would linger for one render frame after a
 * click, which on a fast clicker looks like "click did nothing". */
  const [optimistic, setOptimistic] = useState<
    PermissionGroup["decision"] | null
  >(null);

  const respond = useCallback(
    async (
      decision: NonNullable<PermissionGroup["decision"]>,
      event: MouseEvent<HTMLButtonElement>,
    ) => {
      if (!isTrustedShellxUserEvent(event)) {
        return;
      }
      if (
        debugFixture
        && (
          debugFixture.requestId !== g.requestId
          || debugFixture.expectedDecision !== decision
        )
      ) {
        return;
      }
      setOptimistic(decision);
      const allow = decision === "allow" || decision === "allow_always";
      if (!debugFixture) {
        try {
          await invoke<boolean>("resolve_permission_request", {
            requestId: g.requestId,
            allow,
            decision,
          });
        } catch (err) {
 // Logged but non-fatal — the Rust side times out at 60s and
 // treats as Deny. We still flip the pill to its visual
 // resolved state so the user gets feedback.
 // eslint-disable-next-line no-console
          console.warn("[PermissionPill] resolve invoke failed:", err);
        }
      }
      dispatchSynthetic(
        "permission-resolved",
        {
          requestId: g.requestId,
          decision,
          decisionAt: Date.now(),
          ...(debugFixture ? {
            _meta: {
              [DEBUG_PERMISSION_FIXTURE_META_KEY]: DEBUG_PERMISSION_DECISION_FIXTURE,
            },
          } : {}),
        },
        tabId,
      );
    },
    [debugFixture, g.requestId, tabId],
  );

 /* Effective pill state. `pending` is the source-of-truth flag set by
 * grouping.ts; `optimistic` overlays it locally for the click-to-
 * resolve micro-interaction. */
  const decision = optimistic ?? g.decision ?? null;
  const isPending = g.pending && optimistic === null;

  if (isPending) {
    return (
      <div
        className="row-pill perm-pill perm-pill-pending"
        data-request-id={g.requestId}
        role="group"
        aria-label={`Permission requested for ${g.toolName}`}
      >
        <div className="perm-pill-head">
          <span className="perm-pill-icon" aria-hidden>
            <ShellIcon name="shield-alert" size={15} />
          </span>
          <span className="perm-pill-tool">
            {g.toolName}
          </span>
          {g.toolArgs ? (
            <span className="perm-pill-args" title={g.toolArgs}>
              {g.toolArgs}
            </span>
          ) : null}
          {g.cwd ? (
            <span className="perm-pill-cwd" title={g.cwd}>
              cwd: {g.cwd}
            </span>
          ) : null}
        </div>

        <div className="perm-pill-actions">
          <button data-debug-id="surface-components-permissionpill-1"
            type="button"
            className="perm-pill-btn perm-pill-allow"
            disabled={Boolean(debugFixture && debugFixture.expectedDecision !== "allow")}
            onClick={(event) => void respond("allow", event)}
          >
            <ShellIcon name="check" size={13} />
            <span>Allow</span>
          </button>
          <button
            type="button"
            className="perm-pill-btn perm-pill-allow-always"
            data-shellx-release-control="permission-pill-always"
            disabled={Boolean(debugFixture && debugFixture.expectedDecision !== "allow_always")}
            onClick={(event) => void respond("allow_always", event)}
            title="Allow this tool every time without asking"
          >
            <ShellIcon name="circle-check" size={13} />
            <span>Allow always</span>
          </button>
          <button data-debug-id="surface-components-permissionpill-3"
            type="button"
            className="perm-pill-btn perm-pill-deny"
            disabled={Boolean(debugFixture && debugFixture.expectedDecision !== "deny")}
            onClick={(event) => void respond("deny", event)}
          >
            <ShellIcon name="circle-x" size={13} />
            <span>Deny</span>
          </button>
        </div>
      </div>
    );
  }

 /* Resolved state — one-line audit chip. */
  const isAllowed = decision === "allow" || decision === "allow_always";
  const isCancelled = decision === "cancelled";
  const verbCore = isAllowed ? "Allowed" : isCancelled ? "Closed" : "Denied";
 // Auto-decision: distinguish bypassPermissions vs user-driven so the
 // audit trail reads correctly.
  const verbPrefix = g.autoDecision ? "Auto-" : "";
  const verb = `${verbPrefix}${verbCore.toLowerCase()}`;
  const modeNote =
    g.autoDecision && g.permissionMode
      ? ` (${g.permissionMode})`
      : decision === "allow_always"
        ? " (always)"
        : "";
  return (
    <div
      className={`row-pill perm-pill ${isAllowed ? "perm-pill-allowed" : "perm-pill-denied"}`}
      data-request-id={g.requestId}
      data-shellx-release-control={debugFixture ? "permission-decision-receipt" : undefined}
      data-shellx-release-observe={debugFixture ? "title" : undefined}
      data-permission-decision={debugFixture ? decision ?? undefined : undefined}
      title={debugFixture && decision
        ? "Permission decision receipt — " + debugFixture.action + " — " + decision
        : undefined}
      role="group"
      aria-label={`${verb} ${g.toolName}`}
    >
      <span className="perm-pill-icon" aria-hidden>
        <ShellIcon name={isAllowed ? "circle-check" : isCancelled ? "clock" : "circle-x"} size={14} />
      </span>
      <span className="perm-pill-resolved-label">
        {verb}: <strong>{g.toolName}</strong>
        {modeNote}
      </span>
      {g.toolArgs ? (
        <span className="perm-pill-args" title={g.toolArgs}>
          {g.toolArgs}
        </span>
      ) : null}
    </div>
  );
}
