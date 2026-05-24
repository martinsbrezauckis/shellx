# ShellX UI Rules

ShellX is a dense desktop workbench, not a marketing surface. New UI should
feel quiet, technical, and consistent with the existing three-pane app.

## Foundations

- Use tokens from `src/styles/tokens.css`; do not introduce one-off hex
  palettes, shadows, radii, or font stacks unless the token file changes too.
- Keep the warm near-black surface scale, thin dividers, Onest UI type, and
  Geist Mono metadata/code type.
- Prefer full-width sections, dividers, rows, and compact panels over stacked
  decorative cards.
- Use one primary action per surface. Secondary, destructive, and quiet actions
  must be visually distinct and ordered predictably.

## Product Surfaces

- Start with the working state: what session, environment, file, plan, or
  connector the user is operating on.
- Metadata belongs in small mono chips or muted rows; titles should be real
  headings, not squeezed into utility chrome.
- Keep copy operational. Avoid feature explanations inside the UI unless the
  state is ambiguous or dangerous.
- Do not show local/session health inside global settings unless it is clearly
  scoped to the active session.

## Modals

- Modal layout should be: compact topbar, clear title block, single scrollable
  body, optional edit panel, fixed action footer.
- Avoid dumping markdown or logs as one unstructured blob. Extract obvious
  titles/status into the modal header, then style body headings/lists/tables.
- Keep close/dismiss actions quiet. Keep approve/accept actions visually
  primary. Keep destructive actions red and never adjacent to a primary action
  without spacing.

## Buttons And Controls

- Use existing `.pact`/modal button language for dialog actions unless a shared
  component replaces it.
- Button labels should be short commands: `Accept plan`, `Request changes`,
  `Reject`, `Review later`.
- Disable actions when the required state is unknown. For environment-specific
  installs, only enable install/fix after a session-scoped probe reports the
  tool missing or failed in that environment.

## Markdown And Plans

- Plan review surfaces must promote the first `#` heading to the modal title
  and remove the duplicate title from the markdown body.
- Phase headings need section spacing and dividers. Checklist rows need clear
  spacing and native checkbox styling.
- Inline code should use the tokenized mono chip style; code blocks and tables
  should remain readable inside the modal scroll area.
