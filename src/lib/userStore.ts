/**
 * src/lib/userStore.ts — #435 disk-mirror for personal localStorage keys.
 *
 * Six keys survive across reinstalls (projects, chat titles, session-
 * project mappings, saved sessions, closed-tab history, project
 * collapse state). The Rust
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

export const SESSION_TABS_KEY = "shellX.session-tabs.v3";
export const LEGACY_SESSION_TABS_KEY = "grok-shell.session-tabs.v2";

/** Canonical names of personal-data keys (must match the localStorage
 * key strings used in App.tsx — keep these in sync if you rename). */
export const USER_DATA_KEYS = [
  "shellX.projects.v1",
  "shellX.chatTitles.v1",
  "shellX.sessionProjects.v1",
  SESSION_TABS_KEY,
  "shellX.closedTabs.v1",
  "shellX.v92.projects.collapse",
] as const;

export type UserDataKey = (typeof USER_DATA_KEYS)[number];
export const PROJECTS_COLLAPSE_KEY: UserDataKey = "shellX.v92.projects.collapse";

const LEGACY_USER_DATA_KEYS: Partial<Record<UserDataKey, readonly string[]>> = {
  [SESSION_TABS_KEY]: [LEGACY_SESSION_TABS_KEY],
};

function legacyKeysFor(key: UserDataKey): readonly string[] {
  return LEGACY_USER_DATA_KEYS[key] ?? [];
}

function readLocalStorageWithLegacy(key: UserDataKey): string | null {
  try {
    const canonical = localStorage.getItem(key);
    if (canonical !== null) {
      for (const legacyKey of legacyKeysFor(key)) {
        try { localStorage.removeItem(legacyKey); } catch { /* noop */ }
      }
      return canonical;
    }
  } catch { /* noop */ }
  for (const legacyKey of legacyKeysFor(key)) {
    try {
      const legacy = localStorage.getItem(legacyKey);
      if (legacy !== null) {
        try { localStorage.setItem(key, legacy); } catch { /* noop */ }
        try { localStorage.removeItem(legacyKey); } catch { /* noop */ }
        return legacy;
      }
    } catch { /* noop */ }
  }
  return null;
}

export function readUserDataLocalStorage(key: UserDataKey): string | null {
  return readLocalStorageWithLegacy(key);
}

function tryParseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function normalizeUserDataBlob(blob: Record<string, unknown>): Record<string, unknown> {
  const next = { ...blob };
  for (const key of USER_DATA_KEYS) {
    if (next[key] === undefined) {
      for (const legacyKey of legacyKeysFor(key)) {
        if (next[legacyKey] !== undefined) {
          next[key] = next[legacyKey];
          break;
        }
      }
    }
    for (const legacyKey of legacyKeysFor(key)) delete next[legacyKey];
  }
  return next;
}

/** In-memory cache of the last-known disk blob. Avoids round-tripping
 * every key change through invoke. Updated on every persistUserData. */
let cachedBlob: Record<string, unknown> = {};
let diskHydrated = false;

export function mergeUserDataBlobs(
  diskBlob: Record<string, unknown>,
  pendingBlob: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...normalizeUserDataBlob(diskBlob),
    ...normalizeUserDataBlob(pendingBlob),
  };
}

async function ensureDiskHydratedForWrite(): Promise<boolean> {
  if (diskHydrated) return true;
  try {
    const diskBlob = (await invoke<Record<string, unknown>>("read_user_data")) || {};
    cachedBlob = mergeUserDataBlobs(diskBlob, cachedBlob);
    diskHydrated = true;
    return true;
  } catch (err) {
    try { console.warn("userStore: read_user_data unavailable before write, skipping disk write:", err); } catch { /* noop */ }
    return false;
  }
}

/** Read all reinstall-safe keys off disk; for each one missing from localStorage
 * copy the disk value in. Runs ONCE at App boot. After this, the rest
 * of the codebase reads localStorage and is unchanged. */
export async function hydrateUserData(): Promise<Record<string, unknown>> {
  let blob: Record<string, unknown> = {};
  try {
    blob = (await invoke<Record<string, unknown>>("read_user_data")) || {};
  } catch (err) {
 // Browser-only fallback (no Tauri host) — skip. localStorage stays
 // the only store, matching pre-#435 behavior.
    try { console.warn("userStore: read_user_data unavailable, skipping disk hydrate:", err); } catch { /* noop */ }
    return {};
  }
  cachedBlob = mergeUserDataBlobs(blob, cachedBlob);
  diskHydrated = true;
  let diskNeedsWrite = !jsonEqual(blob, cachedBlob);
  for (const key of USER_DATA_KEYS) {
    const local = readLocalStorageWithLegacy(key);
    const onDisk = cachedBlob[key];
    if (local !== null) {
      const parsedLocal = tryParseJson(local);
      if (parsedLocal.ok && !jsonEqual(cachedBlob[key], parsedLocal.value)) {
        cachedBlob[key] = parsedLocal.value;
        diskNeedsWrite = true;
      }
      continue; // localStorage wins when present (fresh app boot, cached)
    }
    if (onDisk === undefined) continue;
    try {
      localStorage.setItem(key, JSON.stringify(onDisk));
    } catch { /* noop */ }
    for (const legacyKey of legacyKeysFor(key)) {
      try { localStorage.removeItem(legacyKey); } catch { /* noop */ }
    }
  }
  if (diskNeedsWrite) {
    void invoke("write_user_data", { data: cachedBlob }).catch((err) => {
      try { console.warn("userStore: migrated write_user_data failed:", err); } catch { /* noop */ }
    });
  }
  return cachedBlob;
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
  for (const legacyKey of legacyKeysFor(key)) {
    try { localStorage.removeItem(legacyKey); } catch { /* noop */ }
    delete cachedBlob[legacyKey];
  }
  cachedBlob[key] = value;
 // Debounce: a single tab-list edit can trigger 3-4 successive writes.
 // 200 ms covers a typing burst without making the disk version stale.
  if (writeTimer !== null) {
    try { clearTimeout(writeTimer); } catch { /* noop */ }
  }
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void (async () => {
      if (!(await ensureDiskHydratedForWrite())) return;
      await invoke("write_user_data", { data: cachedBlob });
    })().catch((err) => {
      try { console.warn("userStore: write_user_data failed:", err); } catch { /* noop */ }
    });
  }, 200) as unknown as number;
}

/** Remove a single section from both stores. Used by Settings → Data
 * per-row delete buttons. Returns whether the disk had it. */
export async function deleteUserDataSection(key: UserDataKey): Promise<boolean> {
  try { localStorage.removeItem(key); } catch { /* noop */ }
  for (const legacyKey of legacyKeysFor(key)) {
    try { localStorage.removeItem(legacyKey); } catch { /* noop */ }
  }
  delete cachedBlob[key];
  for (const legacyKey of legacyKeysFor(key)) delete cachedBlob[legacyKey];
  let removed = false;
  try {
    removed = await invoke<boolean>("delete_user_data_section", { key });
  } catch (err) {
    try { console.warn("userStore: delete_user_data_section failed:", err); } catch { /* noop */ }
    return false;
  }
  for (const legacyKey of legacyKeysFor(key)) {
    try {
      removed = (await invoke<boolean>("delete_user_data_section", { key: legacyKey })) || removed;
    } catch { /* noop */ }
  }
  return removed;
}

/** Snapshot what's currently on disk. Used by Settings → Data tab to
 * show counts ("12 projects, 38 sessions") without forcing the
 * caller to know the localStorage shape. */
export async function snapshotUserDataCounts(): Promise<Record<UserDataKey, number>> {
  let blob: Record<string, unknown> = {};
  try {
    blob = normalizeUserDataBlob((await invoke<Record<string, unknown>>("read_user_data")) || {});
  } catch { /* noop */ }
  const out: Record<string, number> = {};
  for (const key of USER_DATA_KEYS) {
    let v = blob[key];
    if (v === undefined) {
      for (const legacyKey of legacyKeysFor(key)) {
        if (blob[legacyKey] !== undefined) {
          v = blob[legacyKey];
          break;
        }
      }
    }
    if (Array.isArray(v)) out[key] = v.length;
    else if (v && typeof v === "object") out[key] = Object.keys(v as object).length;
    else out[key] = v === undefined ? 0 : 1;
  }
  return out as Record<UserDataKey, number>;
}
