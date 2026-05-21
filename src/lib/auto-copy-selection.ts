/**
 * src/lib/auto-copy-selection.ts — UX helper.
 *
 * Mouse-selection-release auto-copy, modeled after grok-build's TUI
 * behavior: when the user finishes selecting text inside a scoped
 * container, write the selection to the clipboard automatically so
 * they don't have to chord Ctrl+C.
 *
 * Scope-limited by design — only attached to surfaces where the user
 * is reading content they're likely to paste elsewhere (chat stream,
 * file preview, plan view). NOT applied to inputs / labels / sidebars
 * where auto-copy would be confusing (selecting a button label and
 * having it land in the clipboard is anti-UX).
 *
 * The handler is silent on failure — environments without
 * `navigator.clipboard.writeText` (older WebViews, denied permissions)
 * just no-op rather than surfacing a toast.
 */
export function onMouseUpAutoCopy(
  e: React.MouseEvent<HTMLElement>,
): void {
  void e;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString();
 // Skip 1-char selections (often accidental drags); 2+ is the
 // threshold that filters out single-character mis-clicks.
  if (!text || text.length < 2) return;
  try {
    void navigator.clipboard.writeText(text);
 //  dispatch a window event so a top-level Toast
 // component can render a small "Copied N chars" confirmation,
 // matching grok-build TUI's chat-copy feedback.
    window.dispatchEvent(new CustomEvent("shellx:clipboard-copied", {
      detail: { chars: text.length },
    }));
  } catch { /* unsupported */ }
}
