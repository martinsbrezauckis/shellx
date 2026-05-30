/**
 * src/components/settings/DataTab.tsx — #435 per-section data delete UI.
 *
 * Shows the user-data sections persisted to
 * `~/.shellx/user-data.json` (projects / chat titles / session-project
 * mappings / saved sessions / closed-tab history / project collapse
 * state) plus a per-section count and a delete button. Each delete pops a confirm; on confirm
 * both the on-disk section and the localStorage cache are wiped.
 *
 * Vault and Connections live in their own tabs already with their own
 * delete affordances; this tab does NOT duplicate those — it covers
 * the localStorage-mirrored personal state that has been the painful
 * "lost on reinstall" pain point.
 *
 * Styling: matches Vault/Connections tabs via the shared `.settings-tab-body`
 * shell + new `.data-row-*` rules in App.css. Hairline-divided rows
 * with a multi-line info block on the left + Delete pill on the right,
 * same visual rhythm as `.vault-row` / `.connection-row`.
 */
import { useEffect, useState, type JSX } from "react";
import {
  USER_DATA_KEYS,
  deleteUserDataSection,
  snapshotUserDataCounts,
  type UserDataKey,
} from "../../lib/userStore";

interface Row {
  key: UserDataKey;
  label: string;
  description: string;
}

const ROWS: Row[] = [
  {
    key: "shellX.projects.v1",
    label: "Projects",
    description: "Folder/project markers in the LeftRail (names + cwd assignments).",
  },
  {
    key: "shellX.chatTitles.v1",
    label: "Chat titles",
    description: "Renamed session titles you set via right-click → Rename.",
  },
  {
    key: "shellX.sessionProjects.v1",
    label: "Session ↔ Project map",
    description: "Which project each saved session belongs to.",
  },
  {
    key: "grok-shell.session-tabs.v2",
    label: "Saved sessions",
    description: "Open-tab list restored on next launch.",
  },
  {
    key: "shellX.closedTabs.v1",
    label: "Closed-tab history",
    description: "Recently closed tabs (last 100), restorable via Ctrl+Shift+T.",
  },
  {
    key: "shellX.v92.projects.collapse",
    label: "Project expand/collapse",
    description: "Which project groups are expanded or collapsed in the LeftRail.",
  },
];

export function DataTab(): JSX.Element {
  const [counts, setCounts] = useState<Record<UserDataKey, number>>(
    () => USER_DATA_KEYS.reduce((m, k) => ({ ...m, [k]: 0 }), {} as Record<UserDataKey, number>),
  );
  const [busy, setBusy] = useState<UserDataKey | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const c = await snapshotUserDataCounts();
      setCounts(c);
    } catch { /* noop */ }
  };
  useEffect(() => { void refresh(); }, []);

  const handleDelete = async (row: Row): Promise<void> => {
    const ok = window.confirm(
      `Delete ${row.label.toLowerCase()}? This wipes the on-disk copy AND localStorage. ` +
      `\n\nReinstalling shellX after this will NOT restore them.`,
    );
    if (!ok) return;
    setBusy(row.key);
    try {
      await deleteUserDataSection(row.key);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-tab-body data-tab">
      <p className="settings-tab-hint">
        Personal state shellX persists to{" "}
        <code>~/.shellx/user-data.json</code> so reinstalls don't lose your
        projects, session names, and tab history. Vault and Connections live
        in their own tabs.
      </p>

      <div className="data-row-list">
        {ROWS.map((row) => (
          <div key={row.key} className="data-row">
            <div className="data-row-info">
              <div className="data-row-label">{row.label}</div>
              <div className="data-row-desc">{row.description}</div>
              <div className="data-row-count">
                {counts[row.key] ?? 0} entries on disk
              </div>
            </div>
            <button
              type="button"
              className="settings-pill data-row-delete"
              onClick={() => void handleDelete(row)}
              disabled={busy !== null}
              title={`Delete the ${row.label.toLowerCase()} on disk + in localStorage`}
            >
              {busy === row.key ? "…" : "Delete"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
