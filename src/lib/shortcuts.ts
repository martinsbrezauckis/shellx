/**
 * src/lib/shortcuts.ts — central keyboard-shortcut registry + hook.
 *
 * One source of truth so HelpModal can enumerate every
 * binding and App.tsx can dispatch on a single keydown listener. The
 * registry is data — the hook is the executor.
 *
 * Conventions:
 * - Bindings declared in the SHORTCUT_GROUPS array below. Each row
 * carries the key(s), human label, group, and a runId for testing.
 * - The `match` function returns the registered action whose
 * `match(e)` returns true. Modifier handling honors Mac vs PC:
 * `cmd` matches `event.metaKey` on Mac and `event.ctrlKey` on
 * PC/Linux, so `⌘K` and `Ctrl+K` are the SAME binding (mockup
 * promises both).
 * - Skip-when-typing rule lives here too: any binding marked
 * `skipInInput: true` (default) is suppressed while focus is on
 * an <input>, <textarea>, or contentEditable element.
 *
 * No React imports at the top — this file is pure data + helpers
 * usable from tests. The hook wrapper lives at the bottom.
 */
import { useEffect } from "react";

/** Cross-platform "command" key (⌘ on mac, Ctrl elsewhere). */
export function isCmd(e: KeyboardEvent): boolean {
 // Mac users get ⌘; everyone else gets Ctrl. The test is whether
 // navigator.platform starts with "Mac" — a single read at startup is
 // fine for this purpose.
  const isMac = typeof navigator !== "undefined"
    && /Mac|iPhone|iPad/.test(navigator.platform);
  return isMac ? e.metaKey : e.ctrlKey;
}

/** A registered shortcut. */
export interface ShortcutDef {
 /** Stable id for tests + help modal sort. */
  id: string;
 /** Group label for HelpModal section. */
  group: "Navigation" | "Sessions" | "Editing" | "Autonomy" | "Diff";
 /** Human-readable key combo shown in the help modal. */
  keys: string;
 /** One-line description. */
  desc: string;
 /** Returns true if the keydown event matches this binding. */
  match: (e: KeyboardEvent) => boolean;
 /** Suppress when focus is on an INPUT/TEXTAREA/contentEditable. */
  skipInInput?: boolean;
}

/** Output of useKeyboardShortcuts: caller hands us the action map. */
export type ShortcutHandlers = Partial<Record<string, () => void>>;

/* ─────────────── Registry ─────────────── */

/**
 * The canonical list. Order matches the order rendered in HelpModal.
 * Each `match` is intentionally minimal — we do NOT consume the event
 * here; the caller's handler does that (so they can choose to fall
 * through, e.g. for `j/k` only when a tool card has focus).
 */
export const SHORTCUTS: ShortcutDef[] = [
 // Navigation
  {
    id: "help",
    group: "Navigation",
    keys: "?",
    desc: "Show keyboard shortcuts",
    match: (e) => e.key === "?" && !isCmd(e) && !e.altKey,
    skipInInput: true,
  },
  {
    id: "escape",
    group: "Navigation",
    keys: "Esc",
    desc: "Close modal / cancel selection",
    match: (e) => e.key === "Escape",
    skipInInput: false, // even in inputs Esc should close palette
  },
  {
    id: "palette",
    group: "Navigation",
    keys: "⌘K",
    desc: "Open command palette",
    match: (e) => isCmd(e) && e.key.toLowerCase() === "k",
    skipInInput: false, // ⌘K must work from inside prompt input
  },
  {
    id: "settings",
    group: "Navigation",
    keys: "⌘,",
    desc: "Open settings dialog",
    match: (e) => isCmd(e) && e.key === ",",
    skipInInput: false,
  },
  {
    id: "toggle-terminal",
    group: "Navigation",
    keys: "⌘`",
    desc: "Toggle Chat / Terminal in bottom panel",
 // `event.key` for backtick is "`" on most layouts.
    match: (e) => isCmd(e) && e.key === "`",
    skipInInput: false,
  },

 // Sessions
  {
    id: "new-session",
    group: "Sessions",
    keys: "⌘T",
    desc: "New session tab",
    match: (e) => isCmd(e) && e.key.toLowerCase() === "t",
    skipInInput: false,
  },
  {
    id: "close-session",
    group: "Sessions",
    keys: "⌘W",
    desc: "Close current session tab",
    match: (e) => isCmd(e) && e.key.toLowerCase() === "w",
    skipInInput: false,
  },

 // Editing
  {
    id: "attach",
    group: "Editing",
    keys: "⌘U",
    desc: "Attach file (image, PDF, code…)",
    match: (e) => isCmd(e) && e.key.toLowerCase() === "u",
    skipInInput: false,
  },

 // Autonomy
  {
    id: "cycle-autonomy",
    group: "Autonomy",
    keys: "⇧Tab",
    desc: "Cycle autonomy mode (Confirm → Auto)",
    match: (e) => e.key === "Tab" && e.shiftKey,
    skipInInput: true,
  },

 // Diff navigation (handled per-card; the dispatch still uses this id)
  {
    id: "diff-next",
    group: "Diff",
    keys: "j",
    desc: "Next hunk in focused diff",
    match: (e) =>
      e.key === "j" && !isCmd(e) && !e.altKey && !e.shiftKey,
    skipInInput: true,
  },
  {
    id: "diff-prev",
    group: "Diff",
    keys: "k",
    desc: "Previous hunk in focused diff",
    match: (e) =>
      e.key === "k" && !isCmd(e) && !e.altKey && !e.shiftKey,
    skipInInput: true,
  },
  {
    id: "diff-accept",
    group: "Diff",
    keys: "y",
    desc: "Mark hunk accepted",
    match: (e) =>
      e.key === "y" && !isCmd(e) && !e.altKey && !e.shiftKey,
    skipInInput: true,
  },
  {
    id: "diff-reject",
    group: "Diff",
    keys: "n",
    desc: "Mark hunk rejected",
    match: (e) =>
      e.key === "n" && !isCmd(e) && !e.altKey && !e.shiftKey,
    skipInInput: true,
  },
 // removed `e = Open hunk in editor (stub)`
 // entry. The corresponding handler in ChatOutput.tsx DiffHunks::onKey
 // was deleted inbut the shortcut registration was left behind,
 // so HelpModal/palette advertised an action that did nothing AND `e`
 // was being swallowed from chat context. Cleaner to remove the dead
 // registration than to ship a label that lies.
];

/** Helper: is focus currently inside an editable element? */
export function isInEditable(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * React hook: attaches a single keydown listener and dispatches into
 * the provided handlers map. Caller passes a map of `{ [shortcutId]: fn }`.
 * If a binding fires (`match(e)` returns true and skipInInput permits),
 * the matching handler is called and the event is preventDefault'd +
 * stopPropagation'd. Unhandled keys fall through to other listeners
 * (textarea Enter, native browser shortcuts) untouched.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inEditable = isInEditable(e.target);
      for (const sc of SHORTCUTS) {
        if (sc.skipInInput && inEditable) continue;
        if (!sc.match(e)) continue;
        const fn = handlers[sc.id];
        if (!fn) continue;
        e.preventDefault();
 // preventDefault only — DO NOT stopPropagation. The bubble
 // phase still needs to run so descendant local listeners
 // (BranchPicker, ConnectionPicker close-on-Esc, etc.) can
 // respond to Esc and other shortcuts.
        fn();
        return;
      }
    };
    window.addEventListener("keydown", onKey, true); // capture phase so we win vs browser shortcuts where possible
    return () => window.removeEventListener("keydown", onKey, true);
  }, [handlers]);
}
