import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  setReleaseSurfaceInstalledInputElementValue,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type OpenTab = Record<string, unknown> & { tabId: string; title?: string | null };
type UiState = Record<string, unknown> & {
  activeTabId: string | null;
  openTabs: OpenTab[];
  preview: Record<string, unknown> | null;
};

const ALL_SESSIONS = "[aria-label='All sessions']";
const CLOSE_SESSION = "[aria-label='Close session']";
const RENAME_SESSION = "[aria-label='Rename session']";
const SCROLL_LEFT = "[aria-label='Scroll left']";
const SCROLL_RIGHT = "[aria-label='Scroll right']";
const RENAME_INPUT = "[data-debug-id='session-rename-input']";
const SESSION_TAB = "[data-debug-id='session-tab']";
const DROPDOWN_PREVIEW = "[data-debug-id='surface-components-sessiontabs-11']";
const STRIP_PREVIEW = "[data-debug-id='surface-components-sessiontabs-4']";
const DROPDOWN_ROW = "[title^='#']";
const DROPDOWN_CLOSE = "[title='Close']";
const NEW_SESSION = "[aria-label='New session']";
const RAIL = ".session-tabs-rail";
const LISTBOX = "[role='listbox']";
const PREVIEW_CENTER = "[aria-label='Preview Center']";
const NEUTRAL_SHELL = ".shell";

const exactSelectors = [
  ALL_SESSIONS,
  CLOSE_SESSION,
  RENAME_SESSION,
  SCROLL_LEFT,
  SCROLL_RIGHT,
  RENAME_INPUT,
  SESSION_TAB,
  DROPDOWN_PREVIEW,
  STRIP_PREVIEW,
  DROPDOWN_ROW,
  DROPDOWN_CLOSE,
  NEW_SESSION,
] as const;

export const SESSION_TABS_LIFECYCLE_FIXTURES = ["ui:session-tabs-owned-multi-tab-lifecycle"] as const;
export const SESSION_TABS_LIFECYCLE_CLEANUPS = ["ui:delete-owned-session-tabs-and-restore-baseline"] as const;
export const SESSION_TABS_LIFECYCLE_ORACLES = [
  "ui:disclosure-state-transition",
  "ui:activation:session-tabs-owned-strip-close",
  "ui:activation:session-tabs-rename-trigger",
  "ui:activation:session-tabs-scroll-left-position",
  "ui:activation:session-tabs-scroll-right-position",
  "ui:value-state-transition",
  "ui:activation:session-tabs-active-id",
  "ui:activation:session-tabs-dropdown-preview-state",
  "ui:activation:session-tabs-strip-preview-state",
  "ui:selection-state-transition",
  "ui:activation:session-tabs-owned-dropdown-close",
  "ui:activation:session-tabs-new-owned-tab",
] as const;

export function supportsSessionTabsLifecycleControl(assignment: Assignment): boolean {
  return assignment.surface.source === "src/components/SessionTabs.tsx"
    && exactSelectors.includes(normalizeSelector(assignment.surface.selector ?? "") as typeof exactSelectors[number]);
}

export async function exerciseSessionTabsLifecycle(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignments: Assignment[],
  sourceCommit: string,
): Promise<ReleaseSurfaceDriverOutcome[]> {
  validateAssignments(assignments);
  const outcomes = new Map(assignments.map((assignment) => [
    normalizeSelector(assignment.surface.selector!),
    emptyOutcome(assignment),
  ]));
  const ownedTabIds = new Set<string>();
  let baseline: UiState | null = null;
  let baselineScrollLeft = 0;
  let baselineDropdownOpen = false;
  let baselinePreviewOpen = false;
  let primaryError: string | null = null;

  const outcome = (selector: string): ReleaseSurfaceDriverOutcome => {
    const value = outcomes.get(selector);
    if (!value) throw new Error(`session-tabs outcome is missing ${selector}`);
    return value;
  };
  const markPresent = (selector: string): void => { outcome(selector).present = "pass"; };
  const markInvoke = (selector: string): void => { outcome(selector).invoke = "pass"; };
  const markEffect = (selector: string, detail: string): void => {
    outcome(selector).effect = "pass";
    outcome(selector).observedEffect = detail;
  };

  try {
    baseline = await readUiState(connection);
    if (!baseline.activeTabId || baseline.openTabs.length === 0) {
      throw new Error("session-tabs fixture requires one existing baseline session");
    }
    const baselineIds = baseline.openTabs.map((tab) => tab.tabId);
    if (new Set(baselineIds).size !== baselineIds.length || !baselineIds.includes(baseline.activeTabId)) {
      throw new Error("session-tabs baseline has duplicate tabs or an unknown active id");
    }
    const baselineRail = await observeRail(installedInput);
    baselineScrollLeft = baselineRail.scrollLeft;
    baselineDropdownOpen = await dropdownExpanded(installedInput);
    baselinePreviewOpen = Boolean(await findReleaseSurfaceInstalledInputElement(installedInput, PREVIEW_CENTER));

    if (baselineDropdownOpen) await setDropdown(installedInput, false);
    if (baselinePreviewOpen) {
      await postUi(connection, { openModal: "close", source: "final-surface-session-tabs-setup" });
      await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, PREVIEW_CENTER);
    }

    const newControl = await waitForReleaseSurfaceInstalledInputElement(installedInput, NEW_SESSION);
    markPresent(NEW_SESSION);
    const firstOwned = await createOwnedTab(connection, installedInput, newControl, new Set(baselineIds));
    ownedTabIds.add(firstOwned);
    markInvoke(NEW_SESSION);
    const afterFirstNew = await readUiState(connection);
    assertTabOrder(afterFirstNew, [...baselineIds, firstOwned], "new-session effect");
    if (afterFirstNew.activeTabId !== firstOwned) throw new Error("new-session effect did not activate the exact new tab");
    markEffect(
      NEW_SESSION,
      `One native click appended and activated exactly ${firstOwned} while preserving ${baselineIds.length} baseline tab(s).`,
    );

    let rail = await observeRail(installedInput);
    while (rail.scrollWidth <= rail.clientWidth + 1 || ownedTabIds.size < 7) {
      if (ownedTabIds.size >= 12) throw new Error("session-tabs fixture could not produce deterministic rail overflow");
      const before = new Set((await readUiState(connection)).openTabs.map((tab) => tab.tabId));
      const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, NEW_SESSION);
      const id = await createOwnedTab(connection, installedInput, control, before);
      ownedTabIds.add(id);
      rail = await observeRail(installedInput);
    }

    const owned = [...ownedTabIds];
    const activatedId = owned[0]!;
    const activatedControl = await waitForReleaseSurfaceInstalledInputElement(installedInput, tabSelector(activatedId));
    markPresent(SESSION_TAB);
    await clickReleaseSurfaceInstalledInputElement(installedInput, activatedControl);
    markInvoke(SESSION_TAB);
    await waitForActiveId(connection, activatedId, "strip-tab activation");
    markEffect(SESSION_TAB, `A native strip-tab click selected exact activeTabId ${activatedId}.`);

    const beforeRename = await readUiState(connection);
    const originalTitle = titleFor(beforeRename, activatedId);
    const renameControl = await waitForReleaseSurfaceInstalledInputElement(
      installedInput,
      `${tabSelector(activatedId)} ${RENAME_SESSION}`,
    );
    markPresent(RENAME_SESSION);
    await clickReleaseSurfaceInstalledInputElement(installedInput, renameControl);
    markInvoke(RENAME_SESSION);
    const renameInputSelector = `${tabSelector(activatedId)} ${RENAME_INPUT}`;
    const renameInput = await waitForReleaseSurfaceInstalledInputElement(installedInput, renameInputSelector);
    const initialDraft = await observeReleaseSurfaceInstalledInputElement(installedInput, renameInputSelector, ["value"]);
    if (initialDraft.value !== originalTitle) throw new Error("rename trigger did not seed the exact owned title draft");
    markEffect(RENAME_SESSION, `The owned tab entered rename mode with its exact original title ${JSON.stringify(originalTitle)}.`);

    markPresent(RENAME_INPUT);
    const changedTitle = `Release tab ${sourceCommit.slice(0, 12)}`;
    await clearReleaseSurfaceInstalledInputElement(installedInput, renameInput);
    await setReleaseSurfaceInstalledInputElementValue(installedInput, renameInput, changedTitle);
    const changedDraft = await observeReleaseSurfaceInstalledInputElement(installedInput, renameInputSelector, ["value"]);
    if (changedDraft.value !== changedTitle) throw new Error("rename input did not hold the exact owned title draft");
    markInvoke(RENAME_INPUT);
    await commitRenameByBlur(installedInput);
    await waitForTitle(connection, activatedId, changedTitle, "rename commit");
    markEffect(RENAME_INPUT, `Native text input committed ${JSON.stringify(changedTitle)} to only ${activatedId}.`);

    await renameOwnedTab(installedInput, connection, activatedId, originalTitle);
    await waitForTitle(connection, activatedId, originalTitle, "rename restoration");

    const previewTarget = {
      kind: "file",
      path: `/tmp/shellx-release-session-tabs-${sourceCommit.slice(0, 16)}.txt`,
      tabId: activatedId,
      sessionCwd: "/tmp",
    };
    await postUi(connection, {
      preview: previewTarget,
      source: "final-surface-session-tabs-preview-fixture",
    });
    await waitForPreview(connection, previewTarget, "preview fixture");
    const stripPreview = await waitForReleaseSurfaceInstalledInputElement(
      installedInput,
      `${tabSelector(activatedId)} ${STRIP_PREVIEW}`,
    );
    markPresent(STRIP_PREVIEW);
    await clickReleaseSurfaceInstalledInputElement(installedInput, stripPreview);
    markInvoke(STRIP_PREVIEW);
    await waitForReleaseSurfaceInstalledInputElement(installedInput, PREVIEW_CENTER);
    await waitForActiveId(connection, activatedId, "strip preview activation");
    await waitForPreview(connection, previewTarget, "strip preview state");
    markEffect(STRIP_PREVIEW, `The strip Preview control opened Preview Center for exact owned tab ${activatedId} without changing its target.`);
    await closePreviewCenter(connection, installedInput);

    const allSessions = await waitForReleaseSurfaceInstalledInputElement(installedInput, ALL_SESSIONS);
    markPresent(ALL_SESSIONS);
    await clickReleaseSurfaceInstalledInputElement(installedInput, allSessions);
    markInvoke(ALL_SESSIONS);
    await waitForDropdown(installedInput, true);
    const dropdownState = await readUiState(connection);
    assertTabOrder(dropdownState, [...baselineIds, ...owned], "all-sessions dropdown order");
    markEffect(ALL_SESSIONS, `The All sessions control exposed the listbox for ${dropdownState.openTabs.length} tabs in exact renderer order.`);

    const selectedId = owned[1]!;
    const selectedIndex = indexFor(await readUiState(connection), selectedId);
    const dropdownRowSelector = dropdownSelector(selectedIndex);
    const dropdownRow = await waitForReleaseSurfaceInstalledInputElement(installedInput, dropdownRowSelector);
    markPresent(DROPDOWN_ROW);
    await clickReleaseSurfaceInstalledInputElement(installedInput, dropdownRow);
    markInvoke(DROPDOWN_ROW);
    await waitForActiveId(connection, selectedId, "dropdown selection");
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, LISTBOX);
    markEffect(DROPDOWN_ROW, `The exact owned dropdown row selected activeTabId ${selectedId} and closed the listbox.`);

    await setDropdown(installedInput, true);
    const previewIndex = indexFor(await readUiState(connection), activatedId);
    const dropdownPreviewSelector = `${dropdownSelector(previewIndex)} ${DROPDOWN_PREVIEW}`;
    const dropdownPreview = await waitForReleaseSurfaceInstalledInputElement(installedInput, dropdownPreviewSelector);
    markPresent(DROPDOWN_PREVIEW);
    await clickReleaseSurfaceInstalledInputElement(installedInput, dropdownPreview);
    markInvoke(DROPDOWN_PREVIEW);
    await waitForReleaseSurfaceInstalledInputElement(installedInput, PREVIEW_CENTER);
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, LISTBOX);
    await waitForActiveId(connection, activatedId, "dropdown preview activation");
    await waitForPreview(connection, previewTarget, "dropdown preview state");
    markEffect(DROPDOWN_PREVIEW, `The dropdown Preview control selected ${activatedId}, opened Preview Center, and preserved the exact preview target.`);
    await closePreviewCenter(connection, installedInput);

    const baselineTabControl = await waitForReleaseSurfaceInstalledInputElement(
      installedInput,
      tabSelector(baseline.activeTabId),
    );
    await clickReleaseSurfaceInstalledInputElement(installedInput, baselineTabControl);
    await waitForActiveId(connection, baseline.activeTabId, "overflow baseline activation");
    await waitForRail(installedInput, (value) => value.scrollLeft === baselineScrollLeft, "rail baseline before scrolling");

    const scrollRight = await waitForReleaseSurfaceInstalledInputElement(installedInput, SCROLL_RIGHT);
    markPresent(SCROLL_RIGHT);
    const beforeRight = await observeRail(installedInput);
    await clickReleaseSurfaceInstalledInputElement(installedInput, scrollRight);
    markInvoke(SCROLL_RIGHT);
    const afterRight = await waitForRail(
      installedInput,
      (value) => value.scrollLeft > beforeRight.scrollLeft,
      "scroll-right effect",
    );
    markEffect(SCROLL_RIGHT, `The rail's actual scrollLeft increased from ${beforeRight.scrollLeft} to ${afterRight.scrollLeft}.`);

    const scrollLeft = await waitForReleaseSurfaceInstalledInputElement(installedInput, SCROLL_LEFT);
    markPresent(SCROLL_LEFT);
    await clickReleaseSurfaceInstalledInputElement(installedInput, scrollLeft);
    markInvoke(SCROLL_LEFT);
    const afterLeft = await waitForRail(
      installedInput,
      (value) => value.scrollLeft < afterRight.scrollLeft,
      "scroll-left effect",
    );
    markEffect(SCROLL_LEFT, `The rail's actual scrollLeft decreased from ${afterRight.scrollLeft} to ${afterLeft.scrollLeft}.`);

    const stripCloseId = owned[owned.length - 1]!;
    const beforeStripClose = await readUiState(connection);
    const stripClose = await waitForReleaseSurfaceInstalledInputElement(
      installedInput,
      `${tabSelector(stripCloseId)} ${CLOSE_SESSION}`,
    );
    markPresent(CLOSE_SESSION);
    await clickReleaseSurfaceInstalledInputElement(installedInput, stripClose);
    markInvoke(CLOSE_SESSION);
    ownedTabIds.delete(stripCloseId);
    await waitForTabRemoved(connection, beforeStripClose, stripCloseId, "strip close");
    markEffect(CLOSE_SESSION, `The strip close control removed only owned tab ${stripCloseId} and preserved exact survivor order.`);

    await setDropdown(installedInput, true);
    const dropdownCloseId = [...ownedTabIds].at(-1)!;
    const beforeDropdownClose = await readUiState(connection);
    const dropdownCloseIndex = indexFor(beforeDropdownClose, dropdownCloseId);
    const dropdownCloseSelector = `${dropdownSelector(dropdownCloseIndex)} ${DROPDOWN_CLOSE}`;
    const dropdownClose = await waitForReleaseSurfaceInstalledInputElement(installedInput, dropdownCloseSelector);
    markPresent(DROPDOWN_CLOSE);
    await clickReleaseSurfaceInstalledInputElement(installedInput, dropdownClose);
    markInvoke(DROPDOWN_CLOSE);
    ownedTabIds.delete(dropdownCloseId);
    await waitForTabRemoved(connection, beforeDropdownClose, dropdownCloseId, "dropdown close");
    if (!await dropdownExpanded(installedInput)) throw new Error("dropdown close unexpectedly hid the all-sessions listbox");
    markEffect(DROPDOWN_CLOSE, `The dropdown close control removed only owned tab ${dropdownCloseId} while keeping the listbox visible.`);
    await setDropdown(installedInput, false);
  } catch (error) {
    primaryError = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    try {
      if (await dropdownExpanded(installedInput)) await setDropdown(installedInput, false);
    } catch (error) {
      cleanupErrors.push(`dropdown: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      if (await findReleaseSurfaceInstalledInputElement(installedInput, PREVIEW_CENTER)) {
        await closePreviewCenter(connection, installedInput);
      }
    } catch (error) {
      cleanupErrors.push(`Preview Center: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (baseline) {
      try {
        for (const tabId of [...ownedTabIds]) {
          const control = await waitForReleaseSurfaceInstalledInputElement(
            installedInput,
            `${tabSelector(tabId)} ${CLOSE_SESSION}`,
          );
          await clickReleaseSurfaceInstalledInputElement(installedInput, control);
          ownedTabIds.delete(tabId);
          await waitForUiState(connection, (state) => !state.openTabs.some((tab) => tab.tabId === tabId), `cleanup ${tabId}`);
        }
      } catch (error) {
        cleanupErrors.push(`owned tabs: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await restorePreview(connection, baseline.preview);
        await waitForPreview(connection, baseline.preview, "preview cleanup");
      } catch (error) {
        cleanupErrors.push(`preview: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const active = await readUiState(connection);
        if (active.activeTabId !== baseline.activeTabId) {
          const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, tabSelector(baseline.activeTabId!));
          await clickReleaseSurfaceInstalledInputElement(installedInput, control);
          await waitForActiveId(connection, baseline.activeTabId!, "active-tab cleanup");
        }
        const restored = await readUiState(connection);
        if (JSON.stringify(restored.openTabs) !== JSON.stringify(baseline.openTabs)) {
          throw new Error("cleanup did not restore exact baseline tab count, order, titles, and metadata");
        }
      } catch (error) {
        cleanupErrors.push(`tab baseline: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await waitForRail(installedInput, (value) => value.scrollLeft === baselineScrollLeft, "rail cleanup");
      } catch (error) {
        cleanupErrors.push(`rail: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        if (baselinePreviewOpen) {
          await postUi(connection, { openModal: "preview", source: "final-surface-session-tabs-cleanup" });
          await waitForReleaseSurfaceInstalledInputElement(installedInput, PREVIEW_CENTER);
        }
        if (baselineDropdownOpen) await setDropdown(installedInput, true);
      } catch (error) {
        cleanupErrors.push(`visible state: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const cleanupError = cleanupErrors.join("; ");
    for (const value of outcomes.values()) {
      if (!cleanupError) value.cleanup = "pass";
      if (primaryError && !value.error) value.error = primaryError;
      if (cleanupError) value.error = appendError(value.error, `cleanup: ${cleanupError}`);
      if ([value.present, value.invoke, value.effect, value.cleanup].includes("fail") && !value.error) {
        value.error = "session-tabs lifecycle did not satisfy every required verdict";
      }
    }
  }
  return assignments.map((assignment) => outcome(normalizeSelector(assignment.surface.selector!)));
}

function validateAssignments(assignments: Assignment[]): void {
  if (assignments.length !== exactSelectors.length) {
    throw new Error(`session-tabs lifecycle requires exactly ${exactSelectors.length} assignments`);
  }
  const selectors = new Set(assignments.map((assignment) => normalizeSelector(assignment.surface.selector ?? "")));
  for (const assignment of assignments) {
    if (!supportsSessionTabsLifecycleControl(assignment)
      || assignment.fixtureId !== SESSION_TABS_LIFECYCLE_FIXTURES[0]
      || assignment.cleanupId !== SESSION_TABS_LIFECYCLE_CLEANUPS[0]) {
      throw new Error(`session-tabs lifecycle assignment does not match ${assignment.surface.name}`);
    }
  }
  for (const selector of exactSelectors) {
    if (!selectors.has(selector)) throw new Error(`session-tabs lifecycle is missing ${selector}`);
  }
}

function emptyOutcome(assignment: Assignment): ReleaseSurfaceDriverOutcome {
  return {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No native Session Tabs lifecycle effect was observed.",
  };
}

async function createOwnedTab(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  control: Awaited<ReturnType<typeof waitForReleaseSurfaceInstalledInputElement>>,
  beforeIds: Set<string>,
): Promise<string> {
  await clickReleaseSurfaceInstalledInputElement(installedInput, control);
  const state = await waitForUiState(connection, (candidate) => (
    candidate.openTabs.length === beforeIds.size + 1
    && candidate.openTabs.filter((tab) => !beforeIds.has(tab.tabId)).length === 1
  ), "owned new-session tab");
  const added = state.openTabs.filter((tab) => !beforeIds.has(tab.tabId));
  const id = added[0]!.tabId;
  if (state.openTabs.at(-1)?.tabId !== id || state.activeTabId !== id) {
    throw new Error("owned new-session tab was not appended and activated exactly");
  }
  return id;
}

async function renameOwnedTab(
  installedInput: ReleaseSurfaceInstalledInputSession,
  connection: Connection,
  tabId: string,
  title: string,
): Promise<void> {
  const trigger = await waitForReleaseSurfaceInstalledInputElement(installedInput, `${tabSelector(tabId)} ${RENAME_SESSION}`);
  await clickReleaseSurfaceInstalledInputElement(installedInput, trigger);
  const selector = `${tabSelector(tabId)} ${RENAME_INPUT}`;
  const input = await waitForReleaseSurfaceInstalledInputElement(installedInput, selector);
  await clearReleaseSurfaceInstalledInputElement(installedInput, input);
  await setReleaseSurfaceInstalledInputElementValue(installedInput, input, title);
  await commitRenameByBlur(installedInput);
  await waitForTitle(connection, tabId, title, "owned title restoration");
}

async function commitRenameByBlur(installedInput: ReleaseSurfaceInstalledInputSession): Promise<void> {
  const neutral = await waitForReleaseSurfaceInstalledInputElement(installedInput, NEUTRAL_SHELL);
  await clickReleaseSurfaceInstalledInputElement(installedInput, neutral);
}

async function closePreviewCenter(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
): Promise<void> {
  await postUi(connection, { openModal: "close", source: "final-surface-session-tabs-driver" });
  await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, PREVIEW_CENTER);
}

async function setDropdown(installedInput: ReleaseSurfaceInstalledInputSession, open: boolean): Promise<void> {
  if (await dropdownExpanded(installedInput) !== open) {
    const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, ALL_SESSIONS);
    await clickReleaseSurfaceInstalledInputElement(installedInput, control);
  }
  await waitForDropdown(installedInput, open);
}

async function waitForDropdown(installedInput: ReleaseSurfaceInstalledInputSession, open: boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if (await dropdownExpanded(installedInput) === open) {
        if (open) await waitForReleaseSurfaceInstalledInputElement(installedInput, LISTBOX, { timeoutMs: 500, pollMs: 50 });
        else await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, LISTBOX, { timeoutMs: 500, pollMs: 50 });
        return;
      }
    } catch {
      // React state and the native element settle on adjacent turns.
    }
    await delay(50);
  }
  throw new Error(`all-sessions dropdown did not become ${open ? "open" : "closed"}`);
}

async function dropdownExpanded(installedInput: ReleaseSurfaceInstalledInputSession): Promise<boolean> {
  const value = await observeReleaseSurfaceInstalledInputElement(installedInput, ALL_SESSIONS, ["expanded"]);
  return value.expanded === true;
}

type RailState = { scrollLeft: number; scrollWidth: number; clientWidth: number };

async function observeRail(installedInput: ReleaseSurfaceInstalledInputSession): Promise<RailState> {
  const value = await observeReleaseSurfaceInstalledInputElement(
    installedInput,
    RAIL,
    ["scrollLeft", "scrollWidth", "clientWidth"],
  );
  if (value.scrollLeft === undefined || value.scrollWidth === undefined || value.clientWidth === undefined) {
    throw new Error("session-tabs rail omitted its bounded scroll metrics");
  }
  return { scrollLeft: value.scrollLeft, scrollWidth: value.scrollWidth, clientWidth: value.clientWidth };
}

async function waitForRail(
  installedInput: ReleaseSurfaceInstalledInputSession,
  predicate: (value: RailState) => boolean,
  label: string,
): Promise<RailState> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await observeRail(installedInput);
    if (predicate(value)) return value;
    await delay(50);
  }
  throw new Error(`${label} did not reach the exact bounded rail state`);
}

async function waitForActiveId(connection: Connection, tabId: string, label: string): Promise<void> {
  await waitForUiState(connection, (state) => state.activeTabId === tabId, label);
}

async function waitForTitle(connection: Connection, tabId: string, title: string, label: string): Promise<void> {
  await waitForUiState(connection, (state) => state.openTabs.some((tab) => tab.tabId === tabId && tab.title === title), label);
}

async function waitForPreview(
  connection: Connection,
  expected: Record<string, unknown> | null,
  label: string,
): Promise<void> {
  await waitForUiState(connection, (state) => JSON.stringify(state.preview) === JSON.stringify(expected), label);
}

async function waitForTabRemoved(
  connection: Connection,
  before: UiState,
  tabId: string,
  label: string,
): Promise<void> {
  const expected = before.openTabs.filter((tab) => tab.tabId !== tabId).map((tab) => tab.tabId);
  const after = await waitForUiState(connection, (state) => !state.openTabs.some((tab) => tab.tabId === tabId), label);
  assertTabOrder(after, expected, label);
}

async function restorePreview(connection: Connection, preview: Record<string, unknown> | null): Promise<void> {
  if (preview) await postUi(connection, { preview, source: "final-surface-session-tabs-cleanup" });
  else await postUi(connection, { clearPreview: true, source: "final-surface-session-tabs-cleanup" });
}

async function readUiState(connection: Connection): Promise<UiState> {
  const raw = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
  const openTabs = Array.isArray(raw.openTabs)
    ? raw.openTabs.filter((entry): entry is OpenTab => (
      Boolean(entry && typeof entry === "object" && !Array.isArray(entry)
        && typeof (entry as Record<string, unknown>).tabId === "string")
    ))
    : [];
  return {
    ...raw,
    activeTabId: typeof raw.activeTabId === "string" ? raw.activeTabId : null,
    openTabs,
    preview: raw.preview && typeof raw.preview === "object" && !Array.isArray(raw.preview)
      ? raw.preview as Record<string, unknown>
      : null,
  };
}

async function waitForUiState(
  connection: Connection,
  predicate: (state: UiState) => boolean,
  label: string,
): Promise<UiState> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await readUiState(connection);
    if (predicate(state)) return state;
    await delay(50);
  }
  throw new Error(`${label} did not reach the exact Debug API state`);
}

function assertTabOrder(state: UiState, expectedIds: string[], label: string): void {
  const actual = state.openTabs.map((tab) => tab.tabId);
  if (JSON.stringify(actual) !== JSON.stringify(expectedIds)) {
    throw new Error(`${label} changed tab count/order: ${JSON.stringify(actual)}`);
  }
}

function titleFor(state: UiState, tabId: string): string {
  const tab = state.openTabs.find((entry) => entry.tabId === tabId);
  if (!tab || typeof tab.title !== "string" || !tab.title) throw new Error(`owned tab ${tabId} has no public title`);
  return tab.title;
}

function indexFor(state: UiState, tabId: string): number {
  const index = state.openTabs.findIndex((tab) => tab.tabId === tabId);
  if (index < 0) throw new Error(`owned tab ${tabId} is absent from dropdown order`);
  return index;
}

function tabSelector(tabId: string): string {
  return `[data-tab-id='${attributeValue(tabId)}']`;
}

function dropdownSelector(tabIndex: number): string {
  return `.stab-dropdown [role='option']:nth-child(${tabIndex + 2})`;
}

function attributeValue(value: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) throw new Error("session tab id is not a bounded selector-safe identifier");
  return value;
}

function normalizeSelector(value: string): string {
  return value.replaceAll('"', "'");
}

function appendError(current: string | undefined, detail: string): string {
  return current ? `${current}; ${detail}` : detail;
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", body);
}

async function apiJson<T>(
  connection: Connection,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers = new Headers({ Authorization: `Bearer ${connection.token}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 800)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
