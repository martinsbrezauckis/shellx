import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElementAtFraction,
  contextClickReleaseSurfaceInstalledInputElement,
  performReleaseSurfaceInstalledInputKeyChord,
  setReleaseSurfaceInstalledInputElementValue,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputElement,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type { ReleaseSurfaceDriverOutcome, ReleaseSurfaceDriverRequest } from "../lib/release-surface-driver-protocol";
import {
  cleanupDebugApiSessionFixture,
  nodeReadablePath,
  prepareDebugApiSessionFixture,
  type DebugApiSessionFixture,
} from "./debug-api-session-fixture";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type UiTab = Record<string, unknown> & { tabId: string };
type UiState = Record<string, unknown> & { activeTabId?: unknown; openTabs?: unknown };
type UserData = Record<string, unknown>;
type ControlContext = {
  connection: Connection;
  input: ReleaseSurfaceInstalledInputSession;
  userDataPath: string;
  fixture: DebugApiSessionFixture;
  fixtureBytes: Buffer;
  ownedProjectIds: Set<string>;
  projectId: string;
  projectMarker: string;
  titleMarker: string;
  baselineTab: UiTab;
  baselineTitle: string;
};

const PROJECTS_KEY = "shellX.projects.v1";
const TITLES_KEY = "shellX.chatTitles.v1";
const SESSION_PROJECTS_KEY = "shellX.sessionProjects.v1";
const TABS_KEY = "shellX.session-tabs.v3";
const RETURN_KEY = "\uE006";

export const LEFT_RAIL_LIFECYCLE_DRIVER_ID = "ui-control-left-rail-lifecycle-installed";
export const LEFT_RAIL_LIFECYCLE_FIXTURES = ["ui:left-rail-owned-lifecycle"] as const;
export const LEFT_RAIL_LIFECYCLE_CLEANUPS = [
  "ui:restore-left-rail-titles-assignments-active-tab-close-owned-tabs-delete-owned-project-and-jsonl",
] as const;
export const LEFT_RAIL_LIFECYCLE_ORACLES = [
  "ui:value-state-transition",
  "ui:disclosure-state-transition",
  "ui:activation:project-draft-created",
  "ui:activation:project-delete-dialog-opened",
  "ui:activation:project-marker-deleted",
  "ui:activation:left-rail-open-tab-project-persisted",
  "ui:activation:left-rail-past-session-project-persisted",
  "ui:activation:left-rail-project-dialog-backdrop-cancelled",
  "ui:activation:left-rail-session-dialog-backdrop-cancelled",
  "ui:activation:left-rail-open-tab-focused",
  "ui:activation:left-rail-project-open-tab-focused",
  "ui:activation:left-rail-past-session-reopened",
  "ui:activation:left-rail-project-past-session-reopened",
  "ui:activation:left-rail-project-dialog-button-cancelled",
  "ui:activation:left-rail-session-dialog-button-cancelled",
  "ui:activation:left-rail-open-tab-unfiled",
  "ui:activation:left-rail-past-session-unfiled",
  "ui:activation:owned-project-and-session-deleted",
  "ui:activation:owned-session-file-deleted",
  "ui:activation:owned-row-rename-restored",
  "ui:activation:owned-row-delete-completed",
] as const;

const expectedSurfaceIds = new Set([
  "ui-control:src/components/LeftRail.tsx:[aria-label=\"Delete project\"]@src/components/LeftRail.tsx#6",
  "ui-control:src/components/LeftRail.tsx:[data-debug-id=\"left-add-project\"]@src/components/LeftRail.tsx#2",
  "ui-control:src/components/LeftRail.tsx:[data-debug-id=\"left-project-rename-input\"]@src/components/LeftRail.tsx#4",
  "ui-control:src/components/LeftRail.tsx:[data-debug-id=\"surface-components-leftrail-3\"]@src/components/LeftRail.tsx#3",
  "ui-control:src/components/LeftRail.tsx:[title$=\" — double-click to rename — drop a chat here to file it\"]@src/components/LeftRail.tsx#5",
  "ui-control:src/components/LeftRail.tsx:[title^=\"Remove the label only — the \"][title$=\" chat(s) stay and reappear under \\\"Past chats\\\".|Remove the project label.\"]@src/components/LeftRail.tsx#21",
  "ui-control:src/components/LeftRail.tsx:[data-debug-id=\"left-chat-rename-input\"]@src/components/LeftRail.tsx#13",
  "ui-control:src/components/LeftRail.tsx:[data-debug-id=\"surface-components-leftrail-15\"]@src/components/LeftRail.tsx#15",
  "ui-control:src/components/LeftRail.tsx:[data-debug-id=\"surface-components-leftrail-17\"]@src/components/LeftRail.tsx#17",
  "ui-control:src/components/LeftRail.tsx:[data-debug-id=\"surface-components-leftrail-19\"]@src/components/LeftRail.tsx#19",
  "ui-control:src/components/LeftRail.tsx:[data-debug-id=\"surface-components-leftrail-24\"]@src/components/LeftRail.tsx#24",
  "ui-control:src/components/LeftRail.tsx:[placeholder=\"Chat title\"]@src/components/LeftRail.tsx#10",
  "ui-control:src/components/LeftRail.tsx:[title^=\"Focus tab: \"][title$=\" — use Shift+F10 to move it, or drag it to another project\"]@src/components/LeftRail.tsx#11",
  "ui-control:src/components/LeftRail.tsx:[title^=\"Open chat \\\"\"][title$=\"\\\" — use Shift+F10 to move it, or drag it to another project\"]@src/components/LeftRail.tsx#7",
  "ui-control:src/components/LeftRail.tsx:[title^=\"Reopen \\\"\"][title$=\")\"]@src/components/LeftRail.tsx#14",
  "ui-control:src/components/LeftRail.tsx:[title^=\"Reopen \\\"\"][title$=\"\\\" — use Shift+F10 to move it, or drag it to another project\"]@src/components/LeftRail.tsx#8",
  "ui-control:src/components/LeftRail.tsx:role=button;name=\"Cancel\"@src/components/LeftRail.tsx#23",
  "ui-control:src/components/LeftRail.tsx:role=button;name=\"Cancel\"@src/components/LeftRail.tsx#27",
  "ui-control:src/components/LeftRail.tsx:role=menuitem;name=\"Unfile (remove from project)\"@src/components/LeftRail.tsx#16",
  "ui-control:src/components/LeftRail.tsx:role=menuitem;name=\"Unfile (remove from project)\"@src/components/LeftRail.tsx#18",
  "ui-control:src/components/LeftRail.tsx:[title^=\"Delete the project label AND permanently remove \"][title$=\" session file(s) from disk.\"]@src/components/LeftRail.tsx#22",
  "ui-control:src/components/LeftRail.tsx:role=button;name=\"Delete\"@src/components/LeftRail.tsx#26",
  "ui-control:src/components/RowActions.tsx:[data-debug-id=\"surface-components-rowactions-1\"]@src/components/RowActions.tsx#1",
  "ui-control:src/components/RowActions.tsx:[data-debug-id=\"surface-components-rowactions-2\"]@src/components/RowActions.tsx#2",
]);

export function supportsLeftRailLifecycleControl(assignment: Assignment): boolean {
  return expectedSurfaceIds.has(assignment.surface.id);
}

export async function exerciseLeftRailLifecycleCohort(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  assignments: Assignment[],
): Promise<ReleaseSurfaceDriverOutcome[]> {
  assertExactCohort(assignments);
  await wait(input, "[data-debug-id='left-rail'][data-user-data-ready='true']");
  const outcomes = new Map(assignments.map((assignment) => [assignment.surface.id, emptyOutcome(assignment)]));
  const tokenPath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const userDataPath = join(dirname(tokenPath), "user-data.json");
  const baselineDisk = existsSync(userDataPath) ? readFileSync(userDataPath) : null;
  const baselineState = await uiState(connection);
  const baselineTabs = exactTabs(baselineState);
  const baselineActiveId = exactActiveId(baselineState, baselineTabs);
  const baselineTab = baselineTabs.find((tab) => tab.tabId === baselineActiveId)!;
  const baselineTitle = exactString(baselineTab.title, "baseline active-tab title");
  if (baselineTab.projectId !== null && baselineTab.projectId !== undefined) {
    throw new Error("left-rail lifecycle requires an isolated unfiled active tab baseline");
  }
  if (projectsValue(readUserData(userDataPath)[PROJECTS_KEY]).length !== 0) {
    throw new Error("left-rail lifecycle refuses a profile that already contains project markers");
  }
  const suffix = request.sourceCommit.slice(0, 16);
  const projectMarker = "SHELLX_RELEASE_LEFT_RAIL_PROJECT_" + suffix;
  let fixture: DebugApiSessionFixture | null = null;
  let projectId = "";
  const ownedProjectIds = new Set<string>();
  const cleanupErrors: string[] = [];
  try {
    fixture = prepareDebugApiSessionFixture(request, "ui_left_rail_lifecycle");
    const fixtureBytes = readFileSync(fixture.path);
    await postUi(connection, { refreshPastChats: true });
    for (const assignment of assignments.filter((entry) => (
      entry.surface.id.includes("left-add-project") || entry.surface.id.includes("left-project-rename-input")
    ))) {
      const outcome = outcomes.get(assignment.surface.id)!;
      await operate(outcome, () => exerciseProjectDraft(
        input,
        userDataPath,
        assignment,
        outcome,
        projectMarker,
        ownedProjectIds,
      ));
    }
    projectId = await createProject(input, userDataPath, projectMarker, ownedProjectIds);
    await ensureProjectExpanded(input, projectId);
    const context: ControlContext = {
      connection,
      input,
      userDataPath,
      fixture,
      fixtureBytes,
      ownedProjectIds,
      projectId,
      projectMarker,
      titleMarker: "SHELLX_RELEASE_LEFT_RAIL_TITLE_" + suffix,
      baselineTab,
      baselineTitle,
    };
    for (const assignment of assignments) {
      if (assignment.surface.id.includes("left-add-project")
        || assignment.surface.id.includes("left-project-rename-input")
        || assignment.surface.id.includes("Remove the label only")
        || assignment.surface.id.includes("Delete the project label AND permanently remove")) continue;
      const outcome = outcomes.get(assignment.surface.id)!;
      await operate(outcome, () => exerciseOne(context, assignment, outcome));
    }
    const projectAndSessionsDelete = assignments.find((assignment) => (
      assignment.surface.id.includes("Delete the project label AND permanently remove")
    ));
    if (projectAndSessionsDelete) {
      const outcome = outcomes.get(projectAndSessionsDelete.surface.id)!;
      await operate(outcome, async () => {
        projectId = await exerciseOwnedProjectAndSessionsDelete(context, outcome);
        context.projectId = projectId;
      });
    }
    const markerDelete = assignments.find((assignment) => assignment.surface.id.includes("Remove the label only"));
    if (markerDelete) {
      const outcome = outcomes.get(markerDelete.surface.id)!;
      await operate(outcome, async () => {
        projectId = await exerciseOwnedProjectMarkerDelete(context, outcome);
        context.projectId = projectId;
      });
    }
  } finally {
    if (fixture) {
      try { await closeOwnedTabs(connection, input, fixture.id); } catch (error) { cleanupErrors.push(message(error)); }
      try { await unfileOpen(contextForCleanup(connection, input, userDataPath, fixture, projectId, baselineTab, baselineTitle), baselineTab.tabId); } catch (error) { cleanupErrors.push(message(error)); }
      try { await unfilePast(contextForCleanup(connection, input, userDataPath, fixture, projectId, baselineTab, baselineTitle), fixture.id); } catch (error) { cleanupErrors.push(message(error)); }
    }
    try { await restoreActive(connection, input, baselineActiveId, baselineTabs); } catch (error) { cleanupErrors.push(message(error)); }
    const cleanupProjectIds = new Set([
      ...ownedProjectIds,
      ...(projectId ? [projectId] : []),
      ...projectsValue(readUserData(userDataPath)[PROJECTS_KEY])
        .filter((project) => project.name === projectMarker)
        .map((project) => project.id),
    ]);
    for (const ownedProjectId of cleanupProjectIds) {
      try { await deleteProjectMarker(input, userDataPath, ownedProjectId); } catch (error) { cleanupErrors.push(message(error)); }
    }
    if (fixture) {
      const cleanup = cleanupDebugApiSessionFixture(fixture);
      if (cleanup) cleanupErrors.push(cleanup);
      try { await postUi(connection, { refreshPastChats: true }); } catch (error) { cleanupErrors.push(message(error)); }
    }
    try {
      await delay(400);
      restoreExactFile(userDataPath, baselineDisk);
      const restored = existsSync(userDataPath) ? readFileSync(userDataPath) : null;
      if (!buffersEqual(restored, baselineDisk)) throw new Error("user-data.json did not return to its byte-exact baseline");
    } catch (error) {
      cleanupErrors.push(message(error));
    }
  }
  for (const outcome of outcomes.values()) {
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else outcome.error = appendError(outcome.error, "cleanup: " + cleanupErrors.join("; "));
    finalize(outcome);
  }
  return assignments.map((assignment) => outcomes.get(assignment.surface.id)!);
}

function contextForCleanup(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  userDataPath: string,
  fixture: DebugApiSessionFixture,
  projectId: string,
  baselineTab: UiTab,
  baselineTitle: string,
): ControlContext {
  return {
    connection,
    input,
    userDataPath,
    fixture,
    fixtureBytes: existsSync(fixture.path) ? readFileSync(fixture.path) : Buffer.alloc(0),
    ownedProjectIds: new Set(projectId ? [projectId] : []),
    projectId,
    projectMarker: "",
    titleMarker: "",
    baselineTab,
    baselineTitle,
  };
}

async function exerciseOne(context: ControlContext, assignment: Assignment, outcome: ReleaseSurfaceDriverOutcome): Promise<void> {
  const id = assignment.surface.id;
  if (id.includes("[aria-label=\"Delete project\"]")) return exerciseOwnedProjectDeleteDialog(context, outcome);
  if (id.includes("surface-components-leftrail-3") && id.endsWith("#3")) return exerciseOwnedProjectExpansion(context, outcome, "caret");
  if (id.includes("double-click to rename")) return exerciseOwnedProjectExpansion(context, outcome, "row");
  if (id.includes("left-chat-rename-input")) return exercisePastRename(context, outcome);
  if (id.includes("src/components/RowActions.tsx") && id.endsWith("#1")) return exerciseOwnedRowRename(context, outcome);
  if (id.includes("src/components/RowActions.tsx") && id.endsWith("#2")) return exerciseOwnedRowDelete(context, outcome);
  if (id.includes("placeholder=\"Chat title\"")) return exerciseOpenRename(context, outcome);
  if (id.includes("title^=\"Focus tab: \"")) return exerciseFocus(context, outcome);
  if (id.includes("title^=\"Open chat")) return exerciseProjectFocus(context, outcome);
  if (id.includes("title^=\"Reopen") && id.endsWith("#14")) return exerciseReopen(context, outcome, false);
  if (id.includes("title^=\"Reopen") && id.endsWith("#8")) return exerciseReopen(context, outcome, true);
  if (id.includes("surface-components-leftrail-15")) return exerciseAssignOpen(context, outcome);
  if (id.includes("surface-components-leftrail-17")) return exerciseAssignPast(context, outcome);
  if (id.includes("name=\"Unfile") && id.endsWith("#16")) return exerciseUnfileOpen(context, outcome);
  if (id.includes("name=\"Unfile") && id.endsWith("#18")) return exerciseUnfilePast(context, outcome);
  if (id.includes("surface-components-leftrail-19")) return exerciseProjectCancel(context, outcome, true);
  if (id.includes("name=\"Cancel\"") && id.endsWith("#23")) return exerciseProjectCancel(context, outcome, false);
  if (id.includes("surface-components-leftrail-24")) return exerciseSessionCancel(context, outcome, true);
  if (id.includes("name=\"Cancel\"") && id.endsWith("#27")) return exerciseSessionCancel(context, outcome, false);
  if (id.includes("name=\"Delete\"") && id.endsWith("#26")) return exerciseOwnedSessionDeleteConfirmation(context, outcome);
  throw new Error("unsupported left-rail lifecycle surface " + id);
}

async function exerciseProjectDraft(
  input: ReleaseSurfaceInstalledInputSession,
  userDataPath: string,
  assignment: Assignment,
  outcome: ReleaseSurfaceDriverOutcome,
  marker: string,
  ownedProjectIds: Set<string>,
): Promise<void> {
  const add = await wait(input, "[data-debug-id='left-add-project']");
  outcome.present = "pass";
  await clickElement(input, add);
  outcome.invoke = "pass";
  const draft = await wait(input, "[data-debug-id='left-project-rename-input']");
  const draftProject = await waitOwnedProjectDraft(userDataPath, ownedProjectIds);
  ownedProjectIds.add(draftProject.id);
  if (assignment.surface.id.includes("left-project-rename-input")) {
    await clearReleaseSurfaceInstalledInputElement(input, draft);
    await setReleaseSurfaceInstalledInputElementValue(input, draft, marker);
    await performReleaseSurfaceInstalledInputKeyChord(input, [RETURN_KEY]);
    const data = await waitUserData(
      userDataPath,
      (value) => projectsValue(value[PROJECTS_KEY]).some((project) => project.name === marker),
      "owned project draft persistence",
    );
    const project = projectsValue(data[PROJECTS_KEY]).find((entry) => entry.name === marker);
    if (!project) throw new Error("owned project draft did not expose the exact persisted identity");
    if (project.id !== draftProject.id) throw new Error("owned project rename changed its exact draft identity");
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, "[data-debug-id='left-project-rename-input']");
    outcome.observedEffect = "Native installed text entry persisted the exact isolated project name under one owned marker.";
    outcome.effect = "pass";
    await deleteProjectMarker(input, userDataPath, project.id);
    return;
  } else {
    outcome.observedEffect = "A native installed-input click created one exact isolated inline project draft.";
  }
  outcome.effect = "pass";
  await clearReleaseSurfaceInstalledInputElement(input, draft);
  await performReleaseSurfaceInstalledInputKeyChord(input, [RETURN_KEY]);
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, "[data-debug-id='left-project-rename-input']");
  await waitUserData(userDataPath, (value) => projectsValue(value[PROJECTS_KEY]).length === 0, "empty project draft removal");
}

async function exerciseOwnedProjectExpansion(
  context: ControlContext,
  outcome: ReleaseSurfaceDriverOutcome,
  via: "caret" | "row",
): Promise<void> {
  await ensureProjectCollapsed(context.input, context.projectId);
  const block = ".project-block[data-project-id='" + context.projectId + "']";
  const selector = via === "caret"
    ? block + " [data-debug-id='surface-components-leftrail-3']"
    : block + " .proj-row-main";
  const control = await wait(context.input, selector);
  outcome.present = "pass";
  await clickElement(context.input, control);
  outcome.invoke = "pass";
  await wait(context.input, block + " [data-debug-id='surface-components-leftrail-3'][aria-expanded='true']");
  outcome.effect = "pass";
  outcome.observedEffect = "Native installed input expanded the exact owned project through its " + via + " control.";
}

async function exerciseOwnedProjectDeleteDialog(
  context: ControlContext,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  const block = ".project-block[data-project-id='" + context.projectId + "']";
  const control = await wait(context.input, block + " [aria-label='Delete project']");
  outcome.present = "pass";
  await clickElement(context.input, control);
  outcome.invoke = "pass";
  await wait(context.input, "[role='alertdialog'][aria-labelledby='proj-del-title']");
  outcome.effect = "pass";
  outcome.observedEffect = "Native installed input opened the exact owned project's deletion dialog without deleting any session or marker.";
  await click(context.input, "[role='alertdialog'][aria-labelledby='proj-del-title'] .proj-delete-actions > button:last-child");
  await waitForReleaseSurfaceInstalledInputElementAbsent(context.input, "[role='alertdialog'][aria-labelledby='proj-del-title']");
}

async function exerciseOwnedProjectMarkerDelete(
  context: ControlContext,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<string> {
  const block = ".project-block[data-project-id='" + context.projectId + "']";
  await click(context.input, block + " [aria-label='Delete project']");
  const control = await wait(context.input, "[role='alertdialog'][aria-labelledby='proj-del-title'] .proj-delete-actions > button:first-child");
  outcome.present = "pass";
  await clickElement(context.input, control);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElementAbsent(context.input, block);
  outcome.effect = "pass";
  outcome.observedEffect = "Native installed input deleted only the exact owned empty project marker.";
  return createProject(context.input, context.userDataPath, context.projectMarker, context.ownedProjectIds);
}

async function exerciseOwnedProjectAndSessionsDelete(
  context: ControlContext,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<string> {
  await assignPast(context, context.fixture.id);
  const block = ".project-block[data-project-id='" + context.projectId + "']";
  await click(context.input, block + " [aria-label='Delete project']");
  const control = await wait(
    context.input,
    "[role='alertdialog'][aria-labelledby='proj-del-title'] .proj-delete-actions > button:nth-child(2)",
  );
  outcome.present = "pass";
  await clickElement(context.input, control);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElementAbsent(context.input, block);
  await waitForFileAbsent(context.fixture.path, "owned project session JSONL deletion");
  await waitForReleaseSurfaceInstalledInputElementAbsent(context.input, pastButton(context.fixture.id));
  await waitSessionProject(context.userDataPath, context.fixture.id, null);
  outcome.effect = "pass";
  outcome.observedEffect = "Native installed input deleted the exact owned project marker and its one explicitly assigned disposable session JSONL.";
  await restoreOwnedSession(context);
  return createProject(context.input, context.userDataPath, context.projectMarker, context.ownedProjectIds);
}

async function exercisePastRename(context: ControlContext, outcome: ReleaseSurfaceDriverOutcome): Promise<void> {
  const row = pastRow(context.fixture.id);
  await click(context.input, row + " [data-debug-id='surface-components-rowactions-1']");
  const control = await wait(context.input, row + " [data-debug-id='left-chat-rename-input']");
  outcome.present = "pass";
  await replaceAndCommit(context.input, control, context.titleMarker);
  outcome.invoke = "pass";
  await waitUserData(context.userDataPath, (data) => recordValue(data[TITLES_KEY])[context.fixture.id] === context.titleMarker, "past title persistence");
  outcome.effect = "pass";
  outcome.observedEffect = "The exact owned past-session title was persisted under its session identity.";
  await click(context.input, row + " [data-debug-id='surface-components-rowactions-1']");
  await replaceAndCommit(context.input, await wait(context.input, row + " [data-debug-id='left-chat-rename-input']"), context.fixture.title);
  await waitUserData(context.userDataPath, (data) => recordValue(data[TITLES_KEY])[context.fixture.id] === context.fixture.title, "past title restoration");
}

async function exerciseOwnedRowRename(context: ControlContext, outcome: ReleaseSurfaceDriverOutcome): Promise<void> {
  await exercisePastRename(context, outcome);
  outcome.observedEffect = "The shared RowActions Rename control changed only the exact owned past-session title and restored its persisted title identity.";
}

async function exerciseOwnedRowDelete(context: ControlContext, outcome: ReleaseSurfaceDriverOutcome): Promise<void> {
  await exerciseOwnedSessionDelete(context, outcome);
  outcome.observedEffect = "The shared RowActions Delete control removed only the exact owned disposable session JSONL before the fixture recreated its byte-exact contents.";
}

async function exerciseOwnedSessionDeleteConfirmation(
  context: ControlContext,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  await exerciseOwnedSessionDelete(context, outcome);
  outcome.observedEffect = "The session confirmation Delete button removed only the exact owned disposable session JSONL before the fixture recreated its byte-exact contents.";
}

async function exerciseOwnedSessionDelete(
  context: ControlContext,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  const row = pastRow(context.fixture.id);
  const rowDelete = await wait(context.input, row + " [data-debug-id='surface-components-rowactions-2']");
  if (outcome.oracleId === "ui:activation:owned-row-delete-completed") outcome.present = "pass";
  await clickElement(context.input, rowDelete);
  const control = await wait(
    context.input,
    "[role='alertdialog'][aria-labelledby='sess-del-title'] .proj-delete-actions > button:first-child",
  );
  if (outcome.oracleId !== "ui:activation:owned-row-delete-completed") outcome.present = "pass";
  await clickElement(context.input, control);
  outcome.invoke = "pass";
  await waitForFileAbsent(context.fixture.path, "owned session JSONL deletion");
  await waitForReleaseSurfaceInstalledInputElementAbsent(context.input, pastButton(context.fixture.id));
  outcome.effect = "pass";
  await restoreOwnedSession(context);
}

async function restoreOwnedSession(context: ControlContext): Promise<void> {
  if (context.fixtureBytes.length === 0) throw new Error("owned session fixture bytes were unavailable for exact restoration");
  if (existsSync(context.fixture.path)) throw new Error("owned session JSONL still existed before exact recreation");
  writeFileSync(context.fixture.path, context.fixtureBytes, { flag: "wx", mode: 0o600 });
  if (!readFileSync(context.fixture.path).equals(context.fixtureBytes)) {
    throw new Error("owned session JSONL recreation was not byte-exact");
  }
  await postUi(context.connection, { refreshPastChats: true });
  await wait(context.input, pastButton(context.fixture.id));
}

async function waitForFileAbsent(path: string, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!existsSync(path)) return;
    await delay(100);
  }
  throw new Error(label + " did not settle before timeout");
}

async function exerciseOpenRename(context: ControlContext, outcome: ReleaseSurfaceDriverOutcome): Promise<void> {
  const row = openRow(context.baselineTab.tabId);
  await click(context.input, row + " [data-debug-id='surface-components-rowactions-1']");
  const control = await wait(context.input, row + " [placeholder='Chat title']");
  outcome.present = "pass";
  await replaceAndCommit(context.input, control, context.titleMarker);
  outcome.invoke = "pass";
  await waitUi(context.connection, (state) => hasTabTitle(state, context.baselineTab.tabId, context.titleMarker), "open title state");
  await waitUserData(context.userDataPath, (data) => tabsValue(data[TABS_KEY]).some((tab) => tab.tabId === context.baselineTab.tabId && tab.title === context.titleMarker), "open title persistence");
  outcome.effect = "pass";
  outcome.observedEffect = "The exact open-tab title changed in renderer state and the persisted tab list.";
  await click(context.input, row + " [data-debug-id='surface-components-rowactions-1']");
  await replaceAndCommit(context.input, await wait(context.input, row + " [placeholder='Chat title']"), context.baselineTitle);
  await waitUi(context.connection, (state) => hasTabTitle(state, context.baselineTab.tabId, context.baselineTitle), "open title restoration");
}

async function exerciseFocus(context: ControlContext, outcome: ReleaseSurfaceDriverOutcome): Promise<void> {
  await reopen(context, pastButton(context.fixture.id));
  const control = await wait(context.input, openRow(context.baselineTab.tabId) + " [title^='Focus tab: ']");
  outcome.present = "pass";
  await clickElement(context.input, control);
  outcome.invoke = "pass";
  await waitUi(context.connection, (state) => state.activeTabId === context.baselineTab.tabId, "open-tab focus");
  outcome.effect = "pass";
  outcome.observedEffect = "The exact baseline open tab became the active renderer tab.";
  await closeOwnedTabs(context.connection, context.input, context.fixture.id);
}

async function exerciseProjectFocus(context: ControlContext, outcome: ReleaseSurfaceDriverOutcome): Promise<void> {
  await assignOpen(context, context.baselineTab.tabId);
  await reopen(context, pastButton(context.fixture.id));
  const control = await wait(context.input, projectOpenButton(context.projectId, context.baselineTab.tabId));
  outcome.present = "pass";
  await clickElement(context.input, control);
  outcome.invoke = "pass";
  await waitUi(context.connection, (state) => state.activeTabId === context.baselineTab.tabId, "project open-tab focus");
  outcome.effect = "pass";
  outcome.observedEffect = "The project-nested live-chat control focused the exact persisted tab identity.";
  await unfileOpen(context, context.baselineTab.tabId);
  await closeOwnedTabs(context.connection, context.input, context.fixture.id);
}

async function exerciseReopen(context: ControlContext, outcome: ReleaseSurfaceDriverOutcome, filed: boolean): Promise<void> {
  if (filed) await assignPast(context, context.fixture.id);
  const selector = filed ? projectPastButton(context.projectId, context.fixture.id) : pastButton(context.fixture.id);
  const control = await wait(context.input, selector);
  outcome.present = "pass";
  await clickElement(context.input, control);
  outcome.invoke = "pass";
  await waitOwnedReopened(context.connection, context.fixture.id);
  if (filed) await waitSessionProject(context.userDataPath, context.fixture.id, context.projectId);
  outcome.effect = "pass";
  outcome.observedEffect = "The exact owned " + (filed ? "project-filed" : "unfiled") + " JSONL session reopened as one active renderer tab.";
  await closeOwnedTabs(context.connection, context.input, context.fixture.id);
  if (filed) await unfilePast(context, context.fixture.id);
}

async function exerciseAssignOpen(context: ControlContext, outcome: ReleaseSurfaceDriverOutcome): Promise<void> {
  await openContext(context.input, openRow(context.baselineTab.tabId) + " [title^='Focus tab: ']", "[role='menu'][aria-label='Move chat to project']");
  const control = await wait(context.input, "[role='menu'][aria-label='Move chat to project'] [data-debug-id='surface-components-leftrail-15']");
  outcome.present = "pass";
  await clickElement(context.input, control);
  outcome.invoke = "pass";
  await waitTabProject(context, context.baselineTab.tabId, context.projectId);
  outcome.effect = "pass";
  outcome.observedEffect = "The exact open tab gained the owned project identity in renderer and persisted tab state.";
  await unfileOpen(context, context.baselineTab.tabId);
}

async function exerciseAssignPast(context: ControlContext, outcome: ReleaseSurfaceDriverOutcome): Promise<void> {
  await openContext(context.input, pastButton(context.fixture.id), "[role='menu'][aria-label='Move past chat to project']");
  const control = await wait(context.input, "[role='menu'][aria-label='Move past chat to project'] [data-debug-id='surface-components-leftrail-17']");
  outcome.present = "pass";
  await clickElement(context.input, control);
  outcome.invoke = "pass";
  await waitSessionProject(context.userDataPath, context.fixture.id, context.projectId);
  outcome.effect = "pass";
  outcome.observedEffect = "The exact past-session identity gained the owned persisted project assignment.";
  await unfilePast(context, context.fixture.id);
}

async function exerciseUnfileOpen(context: ControlContext, outcome: ReleaseSurfaceDriverOutcome): Promise<void> {
  await assignOpen(context, context.baselineTab.tabId);
  await openContext(context.input, projectOpenButton(context.projectId, context.baselineTab.tabId), "[role='menu'][aria-label='Move chat to project']");
  const control = await wait(context.input, "[role='menu'][aria-label='Move chat to project'] [role='menuitem'].secondary");
  outcome.present = "pass";
  await clickElement(context.input, control);
  outcome.invoke = "pass";
  await waitTabProject(context, context.baselineTab.tabId, null);
  outcome.effect = "pass";
  outcome.observedEffect = "Unfile removed the exact open-tab project identity in renderer and persisted tab state.";
}

async function exerciseUnfilePast(context: ControlContext, outcome: ReleaseSurfaceDriverOutcome): Promise<void> {
  await assignPast(context, context.fixture.id);
  await openContext(context.input, projectPastButton(context.projectId, context.fixture.id), "[role='menu'][aria-label='Move past chat to project']");
  const control = await wait(context.input, "[role='menu'][aria-label='Move past chat to project'] [role='menuitem'].secondary");
  outcome.present = "pass";
  await clickElement(context.input, control);
  outcome.invoke = "pass";
  await waitSessionProject(context.userDataPath, context.fixture.id, null);
  outcome.effect = "pass";
  outcome.observedEffect = "Unfile removed the exact past-session persisted project assignment.";
}

async function exerciseProjectCancel(context: ControlContext, outcome: ReleaseSurfaceDriverOutcome, backdrop: boolean): Promise<void> {
  await click(context.input, ".project-block[data-project-id='" + context.projectId + "'] [aria-label='Delete project']");
  const selector = backdrop
    ? "[data-debug-id='surface-components-leftrail-19']"
    : "[role='alertdialog'][aria-labelledby='proj-del-title'] .proj-delete-actions > button:last-child";
  const control = await wait(context.input, selector);
  outcome.present = "pass";
  if (backdrop) await clickReleaseSurfaceInstalledInputElementAtFraction(context.input, control, 0.01, 0.01);
  else await clickElement(context.input, control);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElementAbsent(context.input, "[role='alertdialog'][aria-labelledby='proj-del-title']");
  await waitUserData(context.userDataPath, (data) => projectsValue(data[PROJECTS_KEY]).some((project) => project.id === context.projectId && project.name === context.projectMarker), "project cancellation");
  outcome.effect = "pass";
  outcome.observedEffect = "The project " + (backdrop ? "backdrop" : "Cancel button") + " closed the dialog and preserved the exact owned marker.";
}

async function exerciseSessionCancel(context: ControlContext, outcome: ReleaseSurfaceDriverOutcome, backdrop: boolean): Promise<void> {
  const row = openRow(context.baselineTab.tabId);
  await click(context.input, row + " [data-debug-id='surface-components-rowactions-2']");
  const selector = backdrop
    ? "[data-debug-id='surface-components-leftrail-24']"
    : "[role='alertdialog'][aria-labelledby='sess-del-title'] .proj-delete-actions > button:last-child";
  const control = await wait(context.input, selector);
  outcome.present = "pass";
  if (backdrop) await clickReleaseSurfaceInstalledInputElementAtFraction(context.input, control, 0.01, 0.01);
  else await clickElement(context.input, control);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElementAbsent(context.input, "[role='alertdialog'][aria-labelledby='sess-del-title']");
  await waitUi(context.connection, (state) => safeTabs(state).some((tab) => tab.tabId === context.baselineTab.tabId), "session cancellation");
  outcome.effect = "pass";
  outcome.observedEffect = "The session " + (backdrop ? "backdrop" : "Cancel button") + " closed the dialog without removing the baseline tab.";
}

async function createProject(
  input: ReleaseSurfaceInstalledInputSession,
  userDataPath: string,
  marker: string,
  ownedProjectIds: Set<string>,
): Promise<string> {
  await waitUserData(
    userDataPath,
    (value) => !projectsValue(value[PROJECTS_KEY]).some((project) => project.name === marker),
    "owned project marker absence before creation",
  );
  await click(input, "[data-debug-id='left-add-project']");
  const draft = await wait(input, "[data-debug-id='left-project-rename-input']");
  const draftProject = await waitOwnedProjectDraft(userDataPath, ownedProjectIds);
  ownedProjectIds.add(draftProject.id);
  await replaceAndCommit(input, draft, marker);
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, "[data-debug-id='left-project-rename-input']");
  const data = await waitUserData(userDataPath, (value) => projectsValue(value[PROJECTS_KEY]).filter((project) => project.name === marker).length === 1, "owned project persistence");
  const project = projectsValue(data[PROJECTS_KEY]).find((entry) => entry.name === marker);
  if (!project || !/^[A-Za-z0-9._:-]{1,512}$/.test(project.id)) throw new Error("owned project did not expose a bounded exact id");
  if (project.id !== draftProject.id) throw new Error("owned project persistence changed its exact draft identity");
  await wait(input, ".project-block[data-project-id='" + project.id + "']");
  return project.id;
}

async function waitOwnedProjectDraft(
  userDataPath: string,
  ownedProjectIds: Set<string>,
): Promise<{ id: string; name: string }> {
  const data = await waitUserData(
    userDataPath,
    (value) => projectsValue(value[PROJECTS_KEY]).some((project) => (
      project.name === "New project" && !ownedProjectIds.has(project.id)
    )),
    "owned default project draft creation",
  );
  const project = projectsValue(data[PROJECTS_KEY]).find((entry) => (
    entry.name === "New project" && !ownedProjectIds.has(entry.id)
  ));
  if (!project || !/^proj-[a-z0-9]{8}$/.test(project.id)) {
    throw new Error("owned default project draft did not expose its bounded generated identity");
  }
  return project;
}

async function ensureProjectExpanded(input: ReleaseSurfaceInstalledInputSession, projectId: string): Promise<void> {
  const base = ".project-block[data-project-id='" + projectId + "'] [data-debug-id='surface-components-leftrail-3']";
  if (await visible(input, base + "[aria-expanded='true']")) return;
  await click(input, base);
  await wait(input, base + "[aria-expanded='true']");
}

async function ensureProjectCollapsed(input: ReleaseSurfaceInstalledInputSession, projectId: string): Promise<void> {
  const base = ".project-block[data-project-id='" + projectId + "'] [data-debug-id='surface-components-leftrail-3']";
  if (!await visible(input, base + "[aria-expanded='true']")) return;
  await click(input, base);
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, base + "[aria-expanded='true']");
}

async function deleteProjectMarker(
  input: ReleaseSurfaceInstalledInputSession,
  userDataPath: string,
  projectId: string,
): Promise<void> {
  const block = ".project-block[data-project-id='" + projectId + "']";
  if (await visible(input, block)) {
    await click(input, block + " [aria-label='Delete project']");
    await click(input, "[role='alertdialog'][aria-labelledby='proj-del-title'] .proj-delete-actions > button:first-child");
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, block);
  }
  await waitUserData(
    userDataPath,
    (value) => !projectsValue(value[PROJECTS_KEY]).some((project) => project.id === projectId),
    "owned project marker deletion",
  );
}

async function assignOpen(context: ControlContext, tabId: string): Promise<void> {
  const tab = safeTabs(await uiState(context.connection)).find((entry) => entry.tabId === tabId);
  if (tab?.projectId === context.projectId) return;
  await openContext(context.input, openRow(tabId) + " [title^='Focus tab: ']", "[role='menu'][aria-label='Move chat to project']");
  await click(context.input, "[role='menu'][aria-label='Move chat to project'] [data-debug-id='surface-components-leftrail-15']");
  await waitTabProject(context, tabId, context.projectId);
  await ensureProjectExpanded(context.input, context.projectId);
}

async function unfileOpen(context: ControlContext, tabId: string): Promise<void> {
  if (!context.projectId) return;
  const tab = safeTabs(await uiState(context.connection)).find((entry) => entry.tabId === tabId);
  if (!tab || tab.projectId === null || tab.projectId === undefined) return;
  await ensureProjectExpanded(context.input, context.projectId);
  await openContext(context.input, projectOpenButton(context.projectId, tabId), "[role='menu'][aria-label='Move chat to project']");
  await click(context.input, "[role='menu'][aria-label='Move chat to project'] [role='menuitem'].secondary");
  await waitTabProject(context, tabId, null);
}

async function assignPast(context: ControlContext, sessionId: string): Promise<void> {
  if (recordValue(readUserData(context.userDataPath)[SESSION_PROJECTS_KEY])[sessionId] === context.projectId) return;
  await openContext(context.input, pastButton(sessionId), "[role='menu'][aria-label='Move past chat to project']");
  await click(context.input, "[role='menu'][aria-label='Move past chat to project'] [data-debug-id='surface-components-leftrail-17']");
  await waitSessionProject(context.userDataPath, sessionId, context.projectId);
  await ensureProjectExpanded(context.input, context.projectId);
}

async function unfilePast(context: ControlContext, sessionId: string): Promise<void> {
  if (!context.projectId || recordValue(readUserData(context.userDataPath)[SESSION_PROJECTS_KEY])[sessionId] === undefined) return;
  await ensureProjectExpanded(context.input, context.projectId);
  await openContext(context.input, projectPastButton(context.projectId, sessionId), "[role='menu'][aria-label='Move past chat to project']");
  await click(context.input, "[role='menu'][aria-label='Move past chat to project'] [role='menuitem'].secondary");
  await waitSessionProject(context.userDataPath, sessionId, null);
}

async function reopen(context: ControlContext, selector: string): Promise<void> {
  await click(context.input, selector);
  await waitOwnedReopened(context.connection, context.fixture.id);
}

async function waitOwnedReopened(connection: Connection, sessionId: string): Promise<void> {
  await waitUi(connection, (state) => {
    const owned = safeTabs(state).filter((tab) => tab.sessionId === sessionId);
    return owned.length === 1 && state.activeTabId === owned[0]?.tabId;
  }, "owned session reopen");
}

async function closeOwnedTabs(connection: Connection, input: ReleaseSurfaceInstalledInputSession, sessionId: string): Promise<void> {
  for (const tab of safeTabs(await uiState(connection)).filter((entry) => entry.sessionId === sessionId).reverse()) {
    const selector = "[data-tab-id='" + tab.tabId + "'] [aria-label='Close session']";
    await click(input, selector);
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, selector);
  }
  await waitUi(connection, (state) => !safeTabs(state).some((tab) => tab.sessionId === sessionId), "owned tab cleanup");
}

async function restoreActive(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  tabId: string,
  baselineTabs: UiTab[],
): Promise<void> {
  if ((await uiState(connection)).activeTabId !== tabId) await click(input, "[data-tab-id='" + tabId + "']");
  const state = await waitUi(connection, (value) => value.activeTabId === tabId, "active-tab restoration");
  if (JSON.stringify(safeTabs(state).map((tab) => tab.tabId)) !== JSON.stringify(baselineTabs.map((tab) => tab.tabId))) {
    throw new Error("renderer tabs did not return to their exact baseline identities and order");
  }
}

async function waitTabProject(context: ControlContext, tabId: string, projectId: string | null): Promise<void> {
  await waitUi(context.connection, (state) => {
    const tab = safeTabs(state).find((entry) => entry.tabId === tabId);
    return Boolean(tab) && (tab!.projectId ?? null) === projectId;
  }, "renderer tab project transition");
  await waitUserData(context.userDataPath, (data) => {
    const tab = tabsValue(data[TABS_KEY]).find((entry) => entry.tabId === tabId);
    return Boolean(tab) && (tab!.projectId ?? null) === projectId;
  }, "persisted tab project transition");
}

async function waitSessionProject(path: string, sessionId: string, projectId: string | null): Promise<void> {
  await waitUserData(path, (data) => {
    const value = recordValue(data[SESSION_PROJECTS_KEY])[sessionId];
    return projectId === null ? value === undefined : value === projectId;
  }, "persisted past-session project transition");
}

async function openContext(input: ReleaseSurfaceInstalledInputSession, selector: string, menu: string): Promise<void> {
  await contextClickReleaseSurfaceInstalledInputElement(input, await wait(input, selector));
  await wait(input, menu);
}

async function replaceAndCommit(
  input: ReleaseSurfaceInstalledInputSession,
  element: ReleaseSurfaceInstalledInputElement,
  value: string,
): Promise<void> {
  await clearReleaseSurfaceInstalledInputElement(input, element);
  await setReleaseSurfaceInstalledInputElementValue(input, element, value);
  await performReleaseSurfaceInstalledInputKeyChord(input, [RETURN_KEY]);
}

async function click(input: ReleaseSurfaceInstalledInputSession, selector: string): Promise<void> {
  await clickElement(input, await wait(input, selector));
}

async function clickElement(input: ReleaseSurfaceInstalledInputSession, element: ReleaseSurfaceInstalledInputElement): Promise<void> {
  await clickReleaseSurfaceInstalledInputElement(input, element);
}

function wait(input: ReleaseSurfaceInstalledInputSession, selector: string): Promise<ReleaseSurfaceInstalledInputElement> {
  return waitForReleaseSurfaceInstalledInputElement(input, selector);
}

async function visible(input: ReleaseSurfaceInstalledInputSession, selector: string): Promise<boolean> {
  try {
    await waitForReleaseSurfaceInstalledInputElement(input, selector, { timeoutMs: 300, pollMs: 50 });
    return true;
  } catch {
    return false;
  }
}

function openRow(tabId: string): string {
  return ".unfiled-row[data-tab-id='" + tabId + "']";
}

function pastRow(sessionId: string): string {
  return "[data-debug-id='left-past-chat-row'][data-session-id='" + sessionId + "']";
}

function pastButton(sessionId: string): string {
  return pastRow(sessionId) + " [title^='Reopen ']";
}

function projectOpenButton(projectId: string, tabId: string): string {
  return ".project-block[data-project-id='" + projectId + "'] .chat-row[data-tab-id='" + tabId + "'] [title^='Open chat ']";
}

function projectPastButton(projectId: string, sessionId: string): string {
  return ".project-block[data-project-id='" + projectId + "'] .chat-row[data-session-id='" + sessionId + "'] [title^='Reopen ']";
}

async function operate(outcome: ReleaseSurfaceDriverOutcome, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    outcome.error = message(error);
    if (process.env.SHELLX_RELEASE_DRIVER_TRACE === "1") {
      process.stderr.write("[left-rail-lifecycle] " + outcome.id + ": " + outcome.error + "\n");
    }
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
    observedEffect: "No left-rail lifecycle effect was observed.",
  };
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): void {
  if (outcome.error && outcome.present === "pass" && outcome.invoke === "pass" && outcome.effect === "pass" && outcome.cleanup === "pass") {
    outcome.effect = "fail";
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "left-rail lifecycle control did not satisfy every required verdict";
  }
}

function assertExactCohort(assignments: Assignment[]): void {
  const ids = assignments.map((assignment) => assignment.surface.id);
  if (ids.length !== expectedSurfaceIds.size || new Set(ids).size !== ids.length || ids.some((id) => !expectedSurfaceIds.has(id))) {
    throw new Error("left-rail lifecycle driver requires the exact 24-control reversible cohort");
  }
  for (const assignment of assignments) {
    if (assignment.fixtureId !== LEFT_RAIL_LIFECYCLE_FIXTURES[0]
      || assignment.cleanupId !== LEFT_RAIL_LIFECYCLE_CLEANUPS[0]
      || !LEFT_RAIL_LIFECYCLE_ORACLES.includes(assignment.oracleId as typeof LEFT_RAIL_LIFECYCLE_ORACLES[number])) {
      throw new Error("left-rail lifecycle assignment contract drifted for " + assignment.surface.id);
    }
  }
}

function exactTabs(state: UiState): UiTab[] {
  const tabs = safeTabs(state);
  if (!Array.isArray(state.openTabs) || tabs.length !== state.openTabs.length || tabs.length === 0) {
    throw new Error("left-rail baseline did not expose a nonempty exact openTabs array");
  }
  if (new Set(tabs.map((tab) => tab.tabId)).size !== tabs.length) throw new Error("left-rail baseline contained duplicate tab identities");
  return tabs;
}

function safeTabs(state: UiState): UiTab[] {
  return Array.isArray(state.openTabs) ? state.openTabs.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const tab = value as Record<string, unknown>;
    return typeof tab.tabId === "string" && tab.tabId ? [tab as UiTab] : [];
  }) : [];
}

function exactActiveId(state: UiState, tabs: UiTab[]): string {
  const active = typeof state.activeTabId === "string" ? state.activeTabId : "";
  if (!active || !tabs.some((tab) => tab.tabId === active)) throw new Error("left-rail baseline activeTabId was invalid");
  return active;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(label + " must be a nonempty string");
  return value;
}

function hasTabTitle(state: UiState, tabId: string, title: string): boolean {
  return safeTabs(state).some((tab) => tab.tabId === tabId && tab.title === title);
}

async function uiState(connection: Connection): Promise<UiState> {
  return apiJson<UiState>(connection, "GET", "/state/ui");
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", {
    debugSurface: "app",
    source: "final-surface-left-rail-lifecycle",
    ...body,
  });
}

async function waitUi(connection: Connection, predicate: (state: UiState) => boolean, label: string): Promise<UiState> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await uiState(connection);
    if (predicate(state)) return state;
    await delay(100);
  }
  throw new Error(label + " did not settle before timeout");
}

async function waitUserData(path: string, predicate: (data: UserData) => boolean, label: string): Promise<UserData> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const data = readUserData(path);
    if (predicate(data)) return data;
    await delay(100);
  }
  throw new Error(label + " did not persist before timeout");
}

function readUserData(path: string): UserData {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("user-data.json must contain one object");
  return value as UserData;
}

function projectsValue(value: unknown): Array<{ id: string; name: string }> {
  return arrayValue(value).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    return typeof row.id === "string" && typeof row.name === "string" ? [{ id: row.id, name: row.name }] : [];
  });
}

function tabsValue(value: unknown): UiTab[] {
  return arrayValue(value).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    return typeof row.tabId === "string" ? [row as UiTab] : [];
  });
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function restoreExactFile(path: string, baseline: Buffer | null): void {
  if (baseline) writeFileSync(path, baseline, { mode: 0o600 });
  else if (existsSync(path)) unlinkSync(path);
}

function buffersEqual(left: Buffer | null, right: Buffer | null): boolean {
  return left === null || right === null ? left === right : left.equals(right);
}

function appendError(current: string | undefined, next: string): string {
  return current ? current + "; " + next : next;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function apiJson<T>(connection: Connection, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const headers = new Headers({ Authorization: "Bearer " + connection.token });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(connection.base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(method + " " + path + " failed " + response.status + ": " + text.slice(0, 800));
  return (text ? JSON.parse(text) : {}) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
