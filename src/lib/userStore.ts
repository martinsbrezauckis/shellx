/**
 * src/lib/userStore.ts — #435 disk-mirror for personal localStorage keys.
 *
 * Five keys survive across reinstalls (projects, chat titles, session-
 * project mappings, saved sessions, closed-tab history). The Rust
 * `read_user_data` / `write_user_data` Tauri commands persist them to
 * `~/.shellx/user-data.json`. localStorage stays as the fast cache.
 *
 * Read path: `await hydrateUserData` runs ONCE on boot. For every
 * key whose disk value exists but localStorage doesn't, the disk value
 * is copied into localStorage. After hydration, all UI code reads
 * localStorage exactly as before — no change in callers.
 *
 * Write path: `persistUserData(key, value)` writes to localStorage AND
 * sends the full blob to Rust. Callers wrap their existing
 * `localStorage.setItem(KEY, JSON.stringify(v))` calls with this
 * helper. Batched-write is debounced ~200 ms so rapid edits don't
 * thrash the disk.
 *
 * Delete path: `deleteUserDataSection(key)` removes a key from BOTH
 * the disk blob and localStorage. Used by Settings → Data per-row
 * delete buttons.
 */
import { invoke } from "@tauri-apps/api/core";

/** Canonical names of personal-data keys (must match the localStorage
 * key strings used in App.tsx — keep these in sync if you rename). */
export const USER_DATA_KEYS = [
  "shellX.projects.v1",
  "shellX.chatTitles.v1",
  "shellX.sessionProjects.v1",
  "grok-shell.session-tabs.v2",
  "shellX.closedTabs.v1",
] as const;

export type UserDataKey = (typeof USER_DATA_KEYS)[number];

/** In-memory cache of the last-known disk blob. Avoids round-tripping
 * every key change through invoke. Updated on every persistUserData. */
let cachedBlob: Record<string, unknown> = {};

/** Read all five keys off disk; for each one missing from localStorage
 * copy the disk value in. Runs ONCE at App boot. After this, the rest
 * of the codebase reads localStorage and is unchanged. */
export async function hydrateUserData(): Promise<void> {
  let blob: Record<string, unknown> = {};
  try {
    blob = (await invoke<Record<string, unknown>>("read_user_data")) || {};
  } catch (err) {
 // Browser-only fallback (no Tauri host) — skip. localStorage stays
 // the only store, matching pre-#435 behavior.
    try { console.warn("userStore: read_user_data unavailable, skipping disk hydrate:", err); } catch { /* noop */ }
    return;
  }
  cachedBlob = blob;
  for (const key of USER_DATA_KEYS) {
    const onDisk = blob[key];
    if (onDisk === undefined) continue;
    let local: string | null = null;
    try { local = localStorage.getItem(key); } catch { /* noop */ }
    if (local !== null) continue; // localStorage wins when present (fresh app boot, cached)
    try {
      localStorage.setItem(key, JSON.stringify(onDisk));
    } catch { /* noop */ }
  }
}

/** Persist a single key. Writes localStorage (for fast read on the
 * same session) AND ships the full updated blob to Rust. Errors are
 * console.warn'd; the localStorage write still happens so UI state
 * is never lost on transient disk errors. */
let writeTimer: number | null = null;
export function persistUserData(key: UserDataKey, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* noop */ }
  cachedBlob[key] = value;
 // Debounce: a single tab-list edit can trigger 3-4 successive writes.
 // 200 ms covers a typing burst without making the disk version stale.
  if (writeTimer !== null) {
    try { clearTimeout(writeTimer); } catch { /* noop */ }
  }
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void invoke("write_user_data", { data: cachedBlob }).catch((err) => {
      try { console.warn("userStore: write_user_data failed:", err); } catch { /* noop */ }
    });
  }, 200) as unknown as number;
}

/** Remove a single section from both stores. Used by Settings → Data
 * per-row delete buttons. Returns whether the disk had it. */
export async function deleteUserDataSection(key: UserDataKey): Promise<boolean> {
  try { localStorage.removeItem(key); } catch { /* noop */ }
  delete cachedBlob[key];
  try {
    return await invoke<boolean>("delete_user_data_section", { key });
  } catch (err) {
    try { console.warn("userStore: delete_user_data_section failed:", err); } catch { /* noop */ }
    return false;
  }
}

/** Snapshot what's currently on disk. Used by Settings → Data tab to
 * show counts ("12 projects, 38 sessions") without forcing the
 * caller to know the localStorage shape. */
export async function snapshotUserDataCounts(): Promise<Record<UserDataKey, number>> {
  let blob: Record<string, unknown> = {};
  try {
    blob = (await invoke<Record<string, unknown>>("read_user_data")) || {};
  } catch { /* noop */ }
  const out: Record<string, number> = {};
  for (const key of USER_DATA_KEYS) {
    const v = blob[key];
    if (Array.isArray(v)) out[key] = v.length;
    else if (v && typeof v === "object") out[key] = Object.keys(v as object).length;
    else out[key] = v === undefined ? 0 : 1;
  }
  return out as Record<UserDataKey, number>;
}
