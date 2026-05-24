/**
 * src/components/RowActions.tsx — shared rename + delete affordance for
 * sidebar/list rows.
 *
 * Renders the canonical hover-revealed rename + delete icon cluster used
 * across LeftRail's chat/past-chat rows. CSS (.row-edit / .row-del) hides
 * the spans until the parent row is hovered, exactly as the inline
 * duplicates did before extraction.
 *
 * Callers pass discrete callbacks (`onRename`, `onDelete`); each affordance
 * only renders if its callback is provided, preserving the "skip when
 * disabled" semantics of the original sites (e.g. synthetic closed-*
 * past-chat rows pass `onDelete={undefined}`).
 *
 * Each onClick stops propagation before firing the callback so the wrapping
 * row's onClick (open / focus) does not fire when the user clicks an
 * affordance.
 *
 * Markup is wrapped in a Fragment, not a container element, so the parent
 * row's flex layout (and its existing :hover CSS targeting .row-edit /
 * .row-del) keeps working identically.
 */
import type { JSX } from "react";
import { ShellIcon } from "./icons";

export interface RowActionsProps {
 /** Click handler for the rename pencil. Omit to hide the pencil. */
  onRename?: () => void;
 /** Click handler for the delete trash glyph. Omit to hide the trash. */
  onDelete?: () => void;
 /** Tooltip + aria-label for the rename pencil. Defaults to "Rename". */
  renameTitle?: string;
 /** Tooltip + aria-label for the delete trash. Defaults to "Delete". */
  deleteTitle?: string;
}

/**
 * Renders the rename + delete affordance pair for a list row. Returns null when
 * both handlers are absent so the parent row doesn't render an empty
 * fragment.
 */
export function RowActions({
  onRename,
  onDelete,
  renameTitle,
  deleteTitle,
}: RowActionsProps): JSX.Element | null {
  if (!onRename && !onDelete) return null;
  return (
    <>
      {onRename && (
        <span
          className="row-edit"
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onRename();
          }}
          title={renameTitle ?? "Rename"}
          aria-label={renameTitle ?? "Rename"}
        >
          <ShellIcon name="pencil" size={12} />
        </span>
      )}
      {onDelete && (
        <span
          className="row-del"
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title={deleteTitle ?? "Delete"}
          aria-label={deleteTitle ?? "Delete"}
        >
          <ShellIcon name="trash" size={12} />
        </span>
      )}
    </>
  );
}
