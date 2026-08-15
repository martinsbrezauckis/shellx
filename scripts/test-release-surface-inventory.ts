import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RELEASE_PLATFORMS,
  RELEASE_SURFACE_INVENTORY_SCHEMA,
  collectReleaseSurfaceInventory,
  extractDebugApiRoutePairs,
  inventoryJson,
  type ReleasePlatform,
  type ReleaseSurfaceInventory,
} from "./lib/release-surface-inventory";
import {
  FINAL_SURFACE_RECEIPT_SCHEMA,
  loadFinalSurfaceContract,
  verifyFinalSurfaceReceipts,
  type FinalSurfaceReceipt,
} from "./lib/release-surface-receipts";
import { verifyReleaseSurfaceEvidenceFiles } from "./lib/release-surface-evidence-files";
import {
  FINAL_SURFACE_DRIVER_PLAN_SCHEMA,
  loadFinalSurfaceDriverPlan,
  verifyFinalSurfaceDriverPlan,
  type FinalSurfaceDriverPlan,
} from "./lib/release-surface-driver-plan";
import {
  finalSurfaceLedgerMarker,
  validateFinalSurfaceLedgerMarker,
} from "./lib/release-surface-driver-plan-doc";
import { textContentMatches } from "./lib/text-content";
import {
  promotedReleaseUiDebugSurfaces,
  releaseUiDebugCohortDeclarationCount,
  releaseUiDebugSurfaceCohort,
} from "./lib/release-ui-debug-surface-cohorts";
import { CUT_TOOLING_STATES } from "../src/lib/cut-tooling";
import {
  BROWSER_TEACH_CONTROL_DRIVER_ID,
  BROWSER_TEACH_CONTROL_SURFACE_IDS,
  BROWSER_TEACH_DEBUG_ASSIGNMENT_IDS,
  BROWSER_TEACH_DEBUG_DRIVER_ID,
  BROWSER_TEACH_INSTALLED_CLEANUP,
  BROWSER_TEACH_INSTALLED_FIXTURE,
} from "./release-drivers/ui-browser-teach-review-installed-assignments";

const root = resolve(import.meta.dirname, "..");
const generatorSource = readFileSync(
  resolve(root, "scripts", "generate-release-surface-inventory.ts"),
  "utf8",
);
assert(
  generatorSource.includes("if (!textContentMatches(actual, expected))"),
  "the inventory CLI must use the cross-platform text comparison instead of raw CRLF-sensitive bytes",
);
assert(
  textContentMatches("{\r\n  \"ready\": true\r\n}\r\n", "{\n  \"ready\": true\n}\n"),
  "generated-file drift checks must accept Git's native Windows CRLF checkout spelling",
);
assert(
  !textContentMatches("{\r\n  \"ready\": false\r\n}\r\n", "{\n  \"ready\": true\n}\n"),
  "generated-file drift checks must still reject semantic content changes after newline normalization",
);
const generated = collectReleaseSurfaceInventory(root);
const committedText = readFileSync(resolve(root, "release", "surface-inventory.json"), "utf8");

assert.equal(generated.schema, RELEASE_SURFACE_INVENTORY_SCHEMA);
assert(
  textContentMatches(committedText, inventoryJson(generated)),
  "committed release inventory must exactly match shipped source independent of native line endings",
);
assert.deepEqual(generated.platforms, RELEASE_PLATFORMS);
assert.equal(
  generated.items.filter((item) => item.source === "src/components/settings/ReleaseReadinessPanel.tsx").length,
  0,
  "the development/internal-tools-only Release Readiness panel must not enter the installed production inventory",
);
const aboutTabSource = readFileSync(
  resolve(root, "src", "components", "settings", "AboutTab.tsx"),
  "utf8",
);
assert(
  aboutTabSource.includes("const RELEASE_INTERNAL_TOOLS = import.meta.env.VITE_SHELLX_INTERNAL_TOOLS;")
    && aboutTabSource.includes("import.meta.env.DEV ||")
    && aboutTabSource.includes("const ReleaseReadinessPanel = SHOW_RELEASE_READINESS")
    && aboutTabSource.includes('? lazy(() => import("./ReleaseReadinessPanel"))')
    && aboutTabSource.includes(": null;"),
  "the non-shipping inventory exclusion must remain bound to the production build guard and conditional import",
);
assert.equal(
  generated.items.filter((item) => item.name.includes("surface-components-workpreviewpanel-23")).length,
  0,
  "the removed unreachable Work Preview modal must not remain in the installed inventory",
);
assert(generated.counts["tauri-command"] > 100, "inventory captures the complete Tauri command registry");
assert.equal(generated.counts["debug-api-route"], 248, "inventory captures every balanced Debug API route declaration");
assert.deepEqual(
  generated.items
    .filter((item) => item.kind === "debug-api-route" && item.source === "src-tauri/src/debug_api_release_browser_fixture.rs")
    .map((item) => item.name),
  ["POST /release-test/browser/trusted-vault-fixture"],
  "the fixed child-webview bridge remains one explicit exhaustive release surface",
);
assert.deepEqual(
  generated.items
    .filter((item) => item.kind === "debug-api-route" && item.source === "src-tauri/src/debug_api_release_relay.rs")
    .map((item) => item.name)
    .sort(),
  [
    "DELETE /release-test/tauri-invokes/:id",
    "GET /release-test/tauri-invokes/:id",
    "POST /release-test/tauri-invokes",
    "POST /release-test/tauri-invokes/:id/claim",
    "POST /release-test/tauri-invokes/:id/complete",
  ],
  "isolated installed-candidate relay routes remain explicit 100% release surfaces",
);
assert.deepEqual(
  generated.items
    .filter((item) => item.kind === "debug-api-route" && item.source === "src-tauri/src/debug_api_release_native_picker.rs")
    .map((item) => item.name)
    .sort(),
  [
    "DELETE /release-test/native-picker",
    "GET /release-test/native-picker",
    "POST /release-test/native-picker",
  ],
  "isolated native-picker lease routes remain explicit 100% release surfaces",
);
assert.equal(generated.counts["host-mcp-tool"], 108, "inventory captures advertised tools and callable compatibility aliases");
assert.deepEqual(
  generated.items.filter((item) => item.kind === "host-mcp-tool" && item.advertised === false)
    .map((item) => ({ name: item.name, aliasOf: item.aliasOf })).sort((a, b) => a.name.localeCompare(b.name)),
  [
    { name: "session_environment", aliasOf: "environment" },
    { name: "vision_describe_v2", aliasOf: "vision_describe" },
  ],
  "callable hidden Host MCP aliases must remain explicit compatibility surfaces",
);
assert.equal(generated.counts["ui-control"], 696, "inventory captures every shipping actionable UI instance, including finite mapped menus");
assert.equal(generated.counts["ui-debug-surface"], 611, "inventory captures every shipping concrete debug marker instance without deduplication");
assert.deepEqual(generated.occurrenceAccounting.uiControls, {
  candidates: 680,
  excludedNonActions: 23,
  finiteVariantInstances: 50,
  inventoried: 696,
}, "event shields and statically non-addressable inputs must be excluded while finite mapped menus expand into concrete actions");
assert.deepEqual(generated.occurrenceAccounting.uiDebugSurfaces, {
  candidates: 563,
  finiteVariantInstances: 57,
  inventoried: 611,
}, "every concrete debug marker instance must remain in the release ledger");
assert.equal(
  new Set(generated.items.filter((item) => item.kind === "ui-control").map((item) => item.name)).size,
  682,
  "repeated source controls remain separate while finite menu instances use concrete names",
);
assert.equal(
  new Set(generated.items.filter((item) => item.kind === "ui-debug-surface").map((item) => item.name)).size,
  603,
  "repeated debug markers remain separate while finite menu instances use concrete names",
);
assert.equal(generated.copyDerivedInteractiveControls, 222, "copy-derived UI locators remain explicitly visible as brittle coverage");
const headerSource = readFileSync(resolve(root, "src", "components", "Header.tsx"), "utf8");
assert(
  !generated.items.some((item) => item.source === "src/components/Header.tsx" && item.name.includes("surface-components-header-2"))
    && !headerSource.includes("hideAutonomyDial")
    && !headerSource.includes("set_permission_mode")
    && !headerSource.includes("dial-opt"),
  "the permanently hidden legacy Header autonomy dial must not re-enter shipped source or release coverage",
);
assert.deepEqual(
  generated.items
    .filter((item) => item.kind === "ui-control" && item.source === "src/components/WorkPreviewPanel.tsx")
    .filter((item) => item.name.includes("work-preview-kind-"))
    .map((item) => item.selector)
    .sort(),
  [
    '[id="work-preview-kind-auto"]',
    '[id="work-preview-kind-expo"]',
    '[id="work-preview-kind-static"]',
    '[id="work-preview-kind-web"]',
  ],
  "Work Preview kinds must be four concrete durable controls rather than one ambiguous repeated selector",
);
assert.equal(
  generated.items.filter((item) => item.source === "src/components/WorkPreviewPanel.tsx" && item.name.includes('[title="Close"]')).length,
  0,
  "the unreachable duplicate Work Preview stage Close control must not re-enter the shipped inventory",
);
assert.deepEqual(
  generated.items
    .filter((item) => item.kind === "ui-control")
    .filter((item) => item.name.includes('Revealed value for ') || item.name.includes('vault-password-generator-output')),
  [],
  "static readonly Vault output fields must not be misclassified as actionable release controls",
);
assert.equal(new Set(generated.items.map((item) => item.id)).size, generated.items.length, "surface ids are unique");
assert(
  generated.items.filter((item) => item.kind === "ui-control" || item.kind === "ui-debug-surface")
    .every((item) => item.occurrence && item.line && item.id.endsWith(`@${item.source}#${item.occurrence}`)),
  "UI release identities must bind each exact source occurrence",
);
assert.equal(
  generated.items.filter((item) => item.kind === "ui-debug-surface" && item.dynamicSelector).length,
  48,
  "wildcard and conditional-variant debug marker families must be classified",
);
assert.equal(
  generated.items.filter((item) => item.kind === "ui-debug-surface" && item.name.includes("*")).length,
  48,
  "runtime-owned wildcard debug marker source occurrences must remain visible in the ledger",
);
assert(
  generated.items.filter((item) => item.kind === "ui-debug-surface" && item.dynamicSelector)
    .every((item) => item.selector && !item.selector.includes("*")),
  "dynamic debug ids must compile to usable prefix/suffix or variant selectors",
);
const promotedUiDebugSurfaces = promotedReleaseUiDebugSurfaces(generated.items);
assert(
  !generated.items.some((item) => item.kind === "ui-debug-surface" && item.name === "shellx-vault-keyfile-file"),
  "the permanently hidden Vault keyfile input must not be inventoried as a visible debug surface",
);
assert(
  !generated.items.some((item) => (
    item.kind === "ui-control"
      && item.source === "src/components/settings/VaultSetupPanel.tsx"
      && item.inputType === "file"
  )),
  "the permanently hidden Vault keyfile input must not be inventoried as an actionable UI control",
);
assert.equal(
  promotedUiDebugSurfaces.length,
  528,
  "only UI debug surfaces with deterministic owned renderer state may enter the executable lane",
);
assert.deepEqual(
  promotedUiDebugSurfaces
    .filter((item) => item.source === "src/components/TaskManager.tsx" || item.source === "src/components/TaskRunHistory.tsx")
    .reduce<Record<string, number>>((counts, item) => {
      counts[item.source] = (counts[item.source] ?? 0) + 1;
      return counts;
    }, {}),
  {
    "src/components/TaskManager.tsx": 69,
    "src/components/TaskRunHistory.tsx": 7,
  },
  "all Task Manager and run-history markers must retain exact owned renderer fixtures",
);
assert.equal(
  releaseUiDebugCohortDeclarationCount(),
  promotedUiDebugSurfaces.length,
  "every declared UI debug cohort row must still resolve to one exact inventory occurrence",
);
assert.equal(
  promotedUiDebugSurfaces.filter((item) => item.driverFamily === "dynamic-marker").length,
  35,
  "only owned Activity evidence, Browser task/history, bookmark, toolbar, Vault request-action, and Task identity rows currently have deterministic dynamic fixtures",
);
assert(
  promotedUiDebugSurfaces.every((surface) => releaseUiDebugSurfaceCohort(surface)?.fixtureId),
  "every promoted UI debug surface must resolve through the shared exact cohort registry",
);
assert.deepEqual(
  promotedUiDebugSurfaces
    .filter((surface) => (
      surface.source === "src/browser/components/BookmarkSidecar.tsx"
      && surface.name === "shellx-browser-bookmark-*"
    ))
    .map((surface) => ({
      occurrence: surface.occurrence,
      fixtureId: releaseUiDebugSurfaceCohort(surface)?.fixtureId,
    })),
  [
    { occurrence: 1, fixtureId: "ui:browser-bookmark-list-link-owned" },
    { occurrence: 2, fixtureId: "ui:browser-bookmark-list-folder-owned" },
  ],
  "repeated dynamic bookmark render branches must retain occurrence-specific owned fixtures",
);
assert.deepEqual(
  generated.items
    .filter((item) => item.kind === "ui-control" && item.source === "src/components/Settings.tsx" && item.finiteVariant)
    .map((item) => item.finiteVariant),
  [
    "settings-tab-about",
    "settings-tab-connections",
    "settings-tab-connectors",
    "settings-tab-data",
    "settings-tab-desktop",
    "settings-tab-general",
    "settings-tab-shellxagent",
    "settings-tab-vault",
  ],
  "every Settings menu item must be a separately addressable release surface",
);
assert.equal(
  generated.items.filter((item) => item.kind === "ui-control" && item.finiteVariant).length,
  50,
  "all finite mapped UI registries must expand into their concrete runtime instances",
);
assert.equal(
  generated.items.filter((item) => item.kind === "browser-cli-command" && item.delivery === "source-package").length,
  29,
  "Browser CLI coverage must not pretend the source-distributed script is an installed sidecar",
);
assert.deepEqual(
  generated.items.filter((item) => item.platforms.length === 1).map((item) => item.id).sort(),
  [
    "tauri-command:desktop_integration_install_windows_context_menu",
    "tauri-command:desktop_integration_remove_windows_context_menu",
    "tauri-command:desktop_integration_status",
    'ui-control:src/components/settings/DesktopTab.tsx:role=button;name="Install"@src/components/settings/DesktopTab.tsx#3',
    'ui-control:src/components/settings/DesktopTab.tsx:role=button;name="Remove"@src/components/settings/DesktopTab.tsx#2',
  ],
  "Windows-only desktop integration commands and controls must not be required on macOS or Linux",
);
const balancedRouteFixture = extractDebugApiRoutePairs(`
  Router::new()
    .route(
      "/nested",
      get(handler(one(two()))).post(other_handler),
    )
    .route("/delete", axum::routing::delete(delete_handler))
    .route("/strings", get(handler("post(fake)")))
    // .route("/comment", post(phantom))
`);
assert.deepEqual(balancedRouteFixture, [
  { method: "GET", path: "/nested" },
  { method: "POST", path: "/nested" },
  { method: "DELETE", path: "/delete" },
  { method: "GET", path: "/strings" },
], "Debug API route extraction must balance nested calls and ignore strings/comments");
const routeItems = generated.items.filter((item) => item.kind === "debug-api-route");
assert.deepEqual(
  Object.fromEntries(["GET", "POST", "DELETE"].map((method) => [
    method,
    routeItems.filter((item) => item.name.startsWith(`${method} `)).length,
  ])),
  { GET: 91, POST: 149, DELETE: 8 },
  "Debug API inventory method counts must match the concrete router registry",
);
const inventoriedDebugRoutes = new Set(routeItems.map((item) => item.name));
const driverDebugRouteReferences = readdirSync(resolve(root, "scripts", "release-drivers"))
  .filter((name) => name.endsWith(".ts"))
  .flatMap((name) => {
    const source = readFileSync(resolve(root, "scripts", "release-drivers", name), "utf8");
    const pattern = /\b(?:apiJson|apiNoContent|apiRequest|apiFetch)\s*(?:<[^;()]*?>)?\s*\(\s*[^,]+,\s*["'](GET|POST|DELETE)["']\s*,\s*["']([^"']+)["']/g;
    return [...source.matchAll(pattern)].map((match) => {
      const literalPath = match[2]!.split("?", 1)[0]!;
      const normalizedPath = match[1] === "DELETE" && literalPath === "/connections/"
        ? "/connections/:id"
        : literalPath;
      return `${match[1]} ${normalizedPath}`;
    });
  });
assert(driverDebugRouteReferences.length > 300, "release drivers must retain broad literal Debug API route coverage");
assert.deepEqual(
  [...new Set(driverDebugRouteReferences.filter((route) => !inventoriedDebugRoutes.has(route)))].sort(),
  [],
  "every literal Debug API route used by a release driver must exist in the shipped route inventory",
);

const contract = loadFinalSurfaceContract(resolve(root, "release", "surface-contract.json"));
assert.deepEqual(
  contract.updater.requiredPlatforms,
  ["windows-x86_64", "darwin-aarch64", "linux-x86_64"],
  "final contract must fail closed unless every supported updater platform is present",
);
assert.deepEqual(
  contract.updater.requiredChecks,
  [
    "artifact-minisign-verified-against-embedded-pubkey",
    "all-required-platforms-present",
    "release-url-version-bound",
  ],
  "final contract must retain updater signature, completeness, and anti-replay checks",
);
const allLiveRoutes = Object.values(contract.platforms).flatMap((platform) => platform.requiredLiveProviderRoutes);
assert.deepEqual(
  [...new Set(allLiveRoutes.map((route) => route.providerId))].sort(),
  [...contract.requiredProviders].sort(),
  "the minimal paid-canary set must exercise every provider family at least once",
);
for (const [platformId, platform] of Object.entries(contract.platforms)) {
  const declaredRouteIds = new Set(platform.requiredProviderRoutes.map(
    ({ providerId, transportId }) => `${providerId}::${transportId}`,
  ));
  assert(
    platform.requiredLiveProviderRoutes.every(
      ({ providerId, transportId }) => declaredRouteIds.has(`${providerId}::${transportId}`),
    ),
    `${platformId} live canaries must be a subset of its exact identity routes`,
  );
  assert.deepEqual(
    [...new Set(platform.requiredLiveProviderRoutes.map((route) => route.transportId))].sort(),
    [...platform.requiredTransports].sort(),
    `${platformId} must exercise every transport through at least one live provider`,
  );
}
assert.equal(
  allLiveRoutes.length,
  13,
  "the reviewed matrix must stay coverage-minimal instead of regressing to a paid provider cross-product",
);
const loadedLiveDriverPlan = loadFinalSurfaceDriverPlan(resolve(root, "release", "surface-driver-plan.json"));
const liveDriverPlan = verifyFinalSurfaceDriverPlan(
  loadedLiveDriverPlan,
  generated,
  root,
);
assert.equal(liveDriverPlan.status, "ready", "every current 0.3.6 surface must have an executable installed-driver assignment");
assert.equal(liveDriverPlan.counts.inventoryItems, generated.items.length);
assert.equal(liveDriverPlan.counts.inventoryCells, 5_717);
assert.equal(
  liveDriverPlan.counts.ready,
  5_717,
  "every current surface-platform cell must have an executable driver before the frozen release-candidate matrix runs",
);
assert.equal(liveDriverPlan.counts.assigned, 5_717, "every exact surface-platform cell must have an explicit ready or building driver lane");
assert.equal(liveDriverPlan.counts.missing, 0, "the implementation backlog must be typed rather than hidden as missing coverage");
const finalSurfaceGateDoc = readFileSync(resolve(root, "release", "FINAL_SURFACE_GATE.md"), "utf8");
assert.deepEqual(
  validateFinalSurfaceLedgerMarker(finalSurfaceGateDoc, liveDriverPlan),
  [],
  "the human-readable final gate must publish the exact current machine-ledger status",
);
assert.equal(
  validateFinalSurfaceLedgerMarker(
    finalSurfaceGateDoc.replace(
      finalSurfaceLedgerMarker(liveDriverPlan),
      "<!-- shellx-final-surface-ledger: {\"status\":\"building\"} -->",
    ),
    liveDriverPlan,
  ).length,
  1,
  "a stale human-readable ledger marker must fail closed",
);
assert.equal(
  loadedLiveDriverPlan.assignments.filter((assignment) => assignment.driverId.endsWith("-backlog-installed")).length,
  0,
  "the current driver plan must not retain an executable-coverage backlog",
);
assert.deepEqual(
  loadedLiveDriverPlan.assignments
    .filter((assignment) => assignment.driverId.endsWith("-backlog-installed"))
    .reduce<Record<string, number>>((counts, assignment) => {
      const kind = assignment.surfaceId.slice(0, assignment.surfaceId.indexOf(":"));
      counts[kind] = (counts[kind] ?? 0) + 1;
      return counts;
    }, {}),
  {},
  "no surface kind may retain a BUILDING assignment after the Cut installed-input lane is wired",
);
const browserHandoffSheetAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  assignment.surfaceId.includes("src/browser/components/BrowserTabHandoffConfirmation.tsx")
));
assert.equal(browserHandoffSheetAssignments.length, 9, "the handoff sheet must keep every new control and durable marker in the exact ledger");
const browserHandoffControls = browserHandoffSheetAssignments.filter((assignment) => assignment.surfaceId.startsWith("ui-control:"));
const browserHandoffMarkers = browserHandoffSheetAssignments.filter((assignment) => assignment.surfaceId.startsWith("ui-debug-surface:"));
assert.equal(browserHandoffControls.length, 2);
assert.equal(browserHandoffMarkers.length, 7);
assert(browserHandoffControls.every((assignment) => (
  assignment.driverId === "ui-control-bounded-installed"
    && assignment.fixtureId === "ui:browser-owned-tab-delegation"
    && assignment.oracleId === "ui:activation:owned-browser-tab-delegation-transition"
    && assignment.cleanupId === "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window"
)), "the exact handoff controls must use the bounded owned Browser delegation lifecycle");
assert(browserHandoffMarkers.every((assignment) => (
  assignment.driverId === "ui-debug-browser-delegation-installed"
    && assignment.fixtureId === "ui:browser-owned-tab-delegation-marker"
    && assignment.oracleId === "ui:activation:owned-browser-tab-delegation-marker"
    && assignment.cleanupId === "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window"
)), "the exact handoff markers must use the owned native Browser delegation lifecycle");
const browserTeachAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  BROWSER_TEACH_CONTROL_SURFACE_IDS.has(assignment.surfaceId)
    || BROWSER_TEACH_DEBUG_ASSIGNMENT_IDS.has(assignment.surfaceId)
));
assert.equal(browserTeachAssignments.length, 44, "Browser Teach must retain exactly 14 controls and 30 durable markers");
assert(browserTeachAssignments.every((assignment) => (
  assignment.fixtureId === BROWSER_TEACH_INSTALLED_FIXTURE
    && assignment.cleanupId === BROWSER_TEACH_INSTALLED_CLEANUP
    && (assignment.driverId === BROWSER_TEACH_CONTROL_DRIVER_ID || assignment.driverId === BROWSER_TEACH_DEBUG_DRIVER_ID)
)), "every Browser Teach surface must use its native installed lifecycle and isolated candidate teardown");
const newlyPromotedStaticMarkerFixtures = new Map([
  [
    "ui-debug-surface:debug-api-disconnected@src/components/DebugApiConnectionBanner.tsx#1",
    "ui:debug-api-disconnected-banner-visible",
  ],
  [
    "ui-debug-surface:debug-api-retry@src/components/DebugApiConnectionBanner.tsx#2",
    "ui:debug-api-disconnected-banner-visible",
  ],
  [
    "ui-debug-surface:surface-components-attachmentmediaboard-19@src/components/AttachmentMediaBoard.tsx#7",
    "ui:owned-renderer-event-assets-visible",
  ],
  [
    "ui-debug-surface:surface-components-hashautocomplete-1@src/components/HashAutocomplete.tsx#1",
    "ui:owned-hash-autocomplete-row-visible",
  ],
]);
for (const [surfaceId, fixtureId] of newlyPromotedStaticMarkerFixtures) {
  const assignment = loadedLiveDriverPlan.assignments.find((entry) => entry.surfaceId === surfaceId);
  assert.equal(assignment?.driverId, "ui-debug-surface-installed");
  assert.equal(assignment?.fixtureId, fixtureId);
  assert.equal(assignment?.oracleId, "ui:visible-nonempty-rectangle");
  assert.equal(assignment?.cleanupId, "ui:clear-debug-highlight-and-restore-owned-state");
  assert(!assignment?.expectedEffect.startsWith("BUILDING:"));
}
assert.equal(
  loadedLiveDriverPlan.assignments.filter((assignment) => (
    assignment.fixtureId === "ui:activity-permission-excluded-provider-clipboard-or-live-request"
      && assignment.expectedEffect.startsWith("BUILDING: ")
      && assignment.cleanupId === "ui:not-invoked"
  )).length,
  0,
  "provider and clipboard actions moved out of the no-invocation backlog must not retain stale assignments",
);
assert.equal(
  loadedLiveDriverPlan.assignments.filter((assignment) => assignment.surfaceId.includes("PermissionModal")).length,
  0,
  "retired PermissionModal surfaces must stay absent from the release plan",
);
assert(
  loadedLiveDriverPlan.assignments.some((assignment) => (
    assignment.surfaceId.includes("shellx-browser-sidebar-resize")
      && assignment.driverId === "ui-control-bounded-installed"
      && assignment.fixtureId === "ui:browser-sidebar-width-owned-baseline"
      && assignment.oracleId === "ui:activation:browser-sidebar-width-transition"
      && assignment.cleanupId === "ui:restore-browser-sidebar-width-abort-task-and-window"
  )),
  "Browser sidebar resize must use native bounded width input with exact restoration",
);
const startGrokSessionAssignment = loadedLiveDriverPlan.assignments.find((assignment) => (
  assignment.surfaceId === "tauri-command:start_grok_session"
));
assert.equal(startGrokSessionAssignment?.driverId, "tauri-command-installed");
assert.equal(startGrokSessionAssignment?.fixtureId, "tauri:isolated-local-grok-session");
assert.equal(startGrokSessionAssignment?.oracleId, "tauri:start_grok_session:owned-grok-session-active");
assert.equal(startGrokSessionAssignment?.cleanupId, "tauri:abort-owned-grok-session-and-drop-slot");
assert(!startGrokSessionAssignment?.expectedEffect.startsWith("BUILDING:"));
for (const action of ["act-connect", "act-abort"] as const) {
  const assignment = loadedLiveDriverPlan.assignments.find((row) => row.surfaceId === `palette-action:${action}`);
  assert.equal(assignment?.driverId, "palette-action-installed");
  assert.equal(assignment?.fixtureId, "palette:isolated-local-grok-session");
  assert.equal(assignment?.cleanupId, "palette:abort-owned-grok-session-and-restore-tab");
  assert.equal(
    assignment?.oracleId,
    action === "act-connect"
      ? "palette:act-connect:owned-grok-session-active"
      : "palette:act-abort:owned-grok-session-aborted",
  );
  assert(!assignment?.expectedEffect.startsWith("BUILDING:"));
}
const browserMenuAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  assignment.surfaceId.includes("@src/browser/components/BrowserMenus.tsx#")
));
assert.equal(browserMenuAssignments.length, 60, "every exact BrowserMenus control and debug marker must stay assigned");
assert.equal(
  browserMenuAssignments.filter((assignment) => !assignment.driverId.endsWith("-backlog-installed")).length,
  60,
  "every deterministic BrowserMenus lifecycle, exact Browser Save action, and addressability marker must enter an executable lane",
);
assert.equal(
  browserMenuAssignments.filter((assignment) => assignment.driverId.endsWith("-backlog-installed")
    && assignment.expectedEffect.startsWith("BUILDING:")).length,
  0,
  "BrowserMenus must retain no hidden grouped or unexercised BUILDING rows",
);
const agentCliSetupAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  assignment.surfaceId.includes("@src/components/AgentCliSetupAssistant.tsx#")
));
assert.equal(agentCliSetupAssignments.length, 16);
assert.equal(
  agentCliSetupAssignments.filter((assignment) => (
    assignment.driverId === "ui-control-agent-cli-setup-lifecycle-installed"
  )).length,
  8,
  "the two renderer-owned close actions, isolated Recheck, two isolated documentation handoffs, and three owned npm preparation controls may enter the native lifecycle lane",
);
assert.equal(
  agentCliSetupAssignments.filter((assignment) => (
    assignment.driverId === "ui-debug-surface-installed"
  )).length,
  6,
  "all six Agent CLI setup markers must resolve through inert owned renderer fixtures",
);
assert.equal(
  agentCliSetupAssignments.filter((assignment) => assignment.driverId === "ui-control-backlog-installed").length,
  0,
  "every Agent CLI setup control must now have an exact installed lifecycle or inert owned marker lane",
);
const goalPlanReviewAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  assignment.surfaceId.includes("@src/components/GoalPlanReviewModal.tsx#")
));
assert.equal(goalPlanReviewAssignments.length, 12);
assert.equal(
  goalPlanReviewAssignments.filter((assignment) => assignment.driverId === "ui-control-bounded-installed").length,
  8,
  "all five inert and three backing-state Goal Plan Review controls must enter the native lifecycle lane",
);
assert.equal(
  goalPlanReviewAssignments.filter((assignment) => assignment.driverId === "ui-debug-surface-installed").length,
  4,
  "all four Goal Plan Review markers must resolve through inert owned renderer fixtures",
);
assert.equal(
  goalPlanReviewAssignments.filter((assignment) => assignment.driverId === "ui-control-backlog-installed").length,
  0,
  "Goal Plan Review approval, rejection, and feedback must not regress to an unproved backlog lane",
);
const goalPlanDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-goal-plan-review.ts"),
  "utf8",
);
const goalCommandSource = readFileSync(resolve(root, "src-tauri", "src", "lib.rs"), "utf8");
const goalDebugSource = readFileSync(resolve(root, "src-tauri", "src", "debug_api_goals.rs"), "utf8");
const tauriMainSource = readFileSync(resolve(root, "src-tauri", "src", "main.rs"), "utf8");
assert(
  goalPlanDriverSource.includes("releaseTestState: \"awaiting-review\"")
    && goalPlanDriverSource.includes("releaseTestClearState: true")
    && goalPlanDriverSource.includes("SHELLX_PROVIDER_ACTION_RECEIPT")
    && goalPlanDriverSource.includes("Confirm rejection and clear this Goal plan")
    && goalCommandSource.includes("release_goal_provider_fixture_state")
    && goalCommandSource.includes("start_release_goal_provider_fixture")
    && goalDebugSource.includes("release_test_forget_completed_tab")
    && tauriMainSource.includes('"goal-approve"')
    && tauriMainSource.includes('"goal-replan"'),
  "Goal Plan backing actions must remain isolated, provider-receipted, two-click confirmed, and exactly cleaned",
);
const buildRunCockpitAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  assignment.surfaceId.includes("@src/components/BuildRunCockpit.tsx#")
));
assert.equal(buildRunCockpitAssignments.length, 8, "every Build Run Cockpit control must stay exactly assigned");
assert(
  buildRunCockpitAssignments.filter((assignment) => assignment.driverId === "ui-control-bounded-installed").length === 8
    && buildRunCockpitAssignments.filter((assignment) => assignment.driverId === "ui-control-installed").length === 0
    && buildRunCockpitAssignments.some((assignment) => (
      assignment.fixtureId === "ui:build-run-cockpit-owned-terminal-receipts"
      && assignment.oracleId === "ui:boolean-state-transition"
      && assignment.cleanupId === "ui:collapse-and-clear-build-run-fixture-restore-right-rail"
    ))
    && buildRunCockpitAssignments.filter((assignment) => (
      assignment.oracleId === "ui:activation:build-run-cockpit-owned-state-transition"
        && assignment.cleanupId === "ui:clear-owned-build-run-project-provider-git-and-restore-view"
    )).length === 7
    && new Set(buildRunCockpitAssignments.map((assignment) => assignment.fixtureId)).size === 8
    && buildRunCockpitAssignments.every((assignment) => !assignment.expectedEffect.startsWith("BUILDING:")),
  "all eight Build Run Cockpit controls must use exact native installed lifecycles with isolated cleanup",
);
const buildRunDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-build-run-cockpit.ts"),
  "utf8",
);
const debugBuildSource = readFileSync(resolve(root, "src-tauri", "src", "debug_api_builds.rs"), "utf8");
const buildCommandSource = readFileSync(resolve(root, "src-tauri", "src", "lib.rs"), "utf8");
assert(
  buildRunDriverSource.includes("releaseTestState: config.fixtureState")
    && buildRunDriverSource.includes("releaseTestClearState: true")
    && buildRunDriverSource.includes("SHELLX_PROVIDER_ACTION_RECEIPT")
    && buildRunDriverSource.includes("git-checkpoints")
    && debugBuildSource.includes("crate::isolated_test_instance_requested()")
    && debugBuildSource.includes("release_test_forget_completed_tab")
    && debugBuildSource.includes("release_test_clear_tab")
    && buildCommandSource.includes("release_build_provider_fixture_state")
    && buildCommandSource.includes('.consider_continue(&tab_id, "end_turn")')
    && buildCommandSource.includes('"build-approve" | "build-resume"'),
  "Build lifecycle coverage must stay bound to the isolated test instance, real Build/Git state, the fixed JSONL child, exact continuation generation, and exact namespace cleanup",
);
const miscSafeFixtures = new Set([
  "ui:pr-transcript-owned-renderer-baseline",
  "ui:hash-autocomplete-owned-composer-baseline",
  "ui:markdown-link-owned-file-projection",
  "ui:markdown-link-owned-external-projection",
  "ui:debug-api-owned-disconnected-retry",
  "ui:error-boundary-owned-renderer-crash-reset",
  "ui:error-boundary-owned-renderer-crash-reload",
  "ui:update-owned-check",
  "ui:update-owned-available-install-boundary",
  "ui:external-effect-pr-create-boundary",
  "ui:external-effect-artifact-archive-boundary",
]);
const miscSafeAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  (assignment.driverId === "ui-control-installed" || assignment.driverId === "ui-control-bounded-installed")
    && miscSafeFixtures.has(assignment.fixtureId)
));
assert.equal(miscSafeAssignments.length, 14, "fourteen assigned miscellaneous controls have reversible isolated fixtures");
assert(
  miscSafeAssignments.every((assignment) => assignment.cleanupId !== "ui:not-invoked"),
  "every promoted miscellaneous UI lifecycle must carry an exact cleanup",
);
const miscBuildingAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  assignment.driverId === "ui-control-backlog-installed"
    && assignment.fixtureId === "ui:misc-excluded-clipboard-url-provider-updater-git-session-or-destructive-state"
));
assert(
  miscBuildingAssignments.length === 0
    && miscBuildingAssignments.every((assignment) => (
      assignment.expectedEffect.startsWith("BUILDING: ")
      && assignment.expectedEffect.length > 120
      && assignment.cleanupId === "ui:not-invoked"
    )),
  "no miscellaneous provider or remote-mutation action may remain on the BUILDING ledger",
);
assert.equal(
  loadedLiveDriverPlan.assignments.filter((assignment) => (
    assignment.driverId === "ui-control-backlog-installed"
      && assignment.fixtureId === "ui:attachment-media-excluded-native-or-prompt-path"
      && assignment.cleanupId === "ui:not-invoked"
  )).length,
  0,
  "Attachment/Media screenshot controls must no longer remain in the non-invoked backlog",
);
const dataDeleteLifecycleAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  assignment.surfaceId.startsWith("ui-control:src/components/settings/DataTab.tsx:")
    && assignment.driverId === "ui-control-bounded-installed"
));
assert.deepEqual(
  dataDeleteLifecycleAssignments.map((assignment) => ({
    surfaceId: assignment.surfaceId,
    fixtureId: assignment.fixtureId,
    oracleId: assignment.oracleId,
    cleanupId: assignment.cleanupId,
  })).sort((a, b) => a.surfaceId.localeCompare(b.surfaceId)),
  [
    {
      surfaceId: 'ui-control:src/components/settings/DataTab.tsx:[id="data-delete-cancel"]@src/components/settings/DataTab.tsx#2',
      fixtureId: "ui:data-delete-dialog-open",
      oracleId: "ui:activation:data-delete-dialog-cancelled",
      cleanupId: "ui:close-data-delete-dialog-and-settings",
    },
    {
      surfaceId: 'ui-control:src/components/settings/DataTab.tsx:[id="data-delete-confirm"]@src/components/settings/DataTab.tsx#3',
      fixtureId: "ui:data-delete-owned-section",
      oracleId: "ui:activation:data-delete-owned-section-removed",
      cleanupId: "ui:restore-empty-user-data-and-close-settings",
    },
    {
      surfaceId: 'ui-control:src/components/settings/DataTab.tsx:[title^="Delete the "][title$=" on disk + in localStorage"]@src/components/settings/DataTab.tsx#1',
      fixtureId: "ui:data-delete-dialog-closed",
      oracleId: "ui:activation:data-delete-dialog-opened",
      cleanupId: "ui:close-data-delete-dialog-and-settings",
    },
  ],
  "all three Data deletion controls must use reversible native Settings lifecycles, including exact isolated confirmation",
);
const settingsCoreBuildingSurfaceIds: string[] = [];
const settingsCoreBuildingAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  assignment.fixtureId === "ui:settings-core-excluded-external-os-picker-or-destructive-state"
));
assert.deepEqual(
  settingsCoreBuildingAssignments.map((assignment) => assignment.surfaceId).sort(),
  settingsCoreBuildingSurfaceIds,
  "no core Settings updater control may remain in the BUILDING backlog",
);
assert(
  settingsCoreBuildingAssignments.every((assignment) => (
    assignment.driverId === "ui-control-backlog-installed"
      && assignment.expectedEffect.startsWith("BUILDING: ")
      && assignment.cleanupId === "ui:not-invoked"
      && assignment.oracleId.endsWith(":building-blocker")
  )),
  "any future core Settings exclusion must retain a precise typed blocker and never claim invocation",
);
const settingsCoreDebugFixtures = new Map([
  ["src/components/settings/AboutTab.tsx", "ui:settings-about-visible"],
  ["src/components/settings/DesktopTab.tsx", "ui:settings-desktop-visible"],
  ["src/components/settings/GeneralTab.tsx", "ui:settings-general-visible"],
]);
const settingsCoreDebugAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  assignment.surfaceId.startsWith("ui-debug-surface:")
    && [...settingsCoreDebugFixtures.keys()].some((source) => assignment.surfaceId.includes(`@${source}#`))
));
assert.equal(settingsCoreDebugAssignments.length, 13);
assert(
  settingsCoreDebugAssignments.every((assignment) => {
    const source = [...settingsCoreDebugFixtures.keys()].find((candidate) => assignment.surfaceId.includes(`@${candidate}#`));
    return source !== undefined
      && assignment.driverId === "ui-debug-surface-installed"
      && assignment.fixtureId === settingsCoreDebugFixtures.get(source)
      && assignment.expectedEffect.includes("no control activation is claimed");
  }),
  "all core Settings debug markers must stay addressable through their exact inert tab fixture without claiming semantic activation",
);
const executableUiDebugAssignments = loadedLiveDriverPlan.assignments.filter(
  (assignment) => assignment.driverId === "ui-debug-surface-installed",
);
assert.equal(executableUiDebugAssignments.length, 527);
assert(
  executableUiDebugAssignments.every((assignment) => assignment.expectedEffect.includes("no control activation is claimed")),
  "debug addressability assignments must never claim the corresponding control's semantic action",
);
const vaultRevealMarkerAssignment = loadedLiveDriverPlan.assignments.find((assignment) => (
  assignment.surfaceId === "ui-debug-surface:vault-row-reveal@src/components/settings/VaultTab.tsx#11"
));
assert(
  vaultRevealMarkerAssignment?.driverId === "ui-debug-vault-row-reveal-installed"
    && vaultRevealMarkerAssignment.fixtureId === "ui:vault-owned-secret-reveal-marker"
    && vaultRevealMarkerAssignment.oracleId === "ui:visible:vault-owned-sensitive-row-without-value-observation"
    && vaultRevealMarkerAssignment.cleanupId === "ui:hide-owned-vault-secret-delete-exact-owned-key-and-restore-settings",
  "the sensitive Vault reveal marker must use native input and a value-blind container-only proof",
);
const browserDownloadsBadgeAssignment = loadedLiveDriverPlan.assignments.find((assignment) => (
  assignment.surfaceId === "ui-debug-surface:shellx-browser-downloads-badge@src/browser/components/BrowserChrome.tsx#24"
));
assert(
  browserDownloadsBadgeAssignment?.driverId === "ui-debug-surface-installed"
    && browserDownloadsBadgeAssignment.fixtureId === "ui:browser-downloads-badge-owned-intent"
    && browserDownloadsBadgeAssignment.cleanupId === "ui:close-owned-browser-task-with-candidate-teardown",
  "Browser downloads badge must use one real owned transfer intent and candidate teardown",
);
const browserShellPromotedAssignments = new Map(
  loadedLiveDriverPlan.assignments
    .filter((assignment) => [
      'ui-control:src/components/ShellxBrowserApp.tsx:[data-debug-id="shellx-browser-personal-lock-notice-unlock"]@src/components/ShellxBrowserApp.tsx#1',
      'ui-control:src/components/ShellxBrowserApp.tsx:[data-debug-id="shellx-browser-personal-lock-overlay-pin"]@src/components/ShellxBrowserApp.tsx#2',
      'ui-control:src/components/ShellxBrowserApp.tsx:[data-debug-id="shellx-browser-personal-lock-overlay-unlock"]@src/components/ShellxBrowserApp.tsx#3',
      'ui-debug-surface:shellx-browser-personal-lock-notice@src/components/ShellxBrowserApp.tsx#1',
      'ui-debug-surface:shellx-browser-personal-lock-notice-unlock@src/components/ShellxBrowserApp.tsx#2',
      'ui-debug-surface:shellx-browser-personal-lock-overlay@src/components/ShellxBrowserApp.tsx#3',
      'ui-debug-surface:shellx-browser-personal-lock-overlay-pin@src/components/ShellxBrowserApp.tsx#4',
      'ui-debug-surface:shellx-browser-personal-lock-overlay-unlock@src/components/ShellxBrowserApp.tsx#5',
      'ui-debug-surface:shellx-browser-error@src/components/ShellxBrowserApp.tsx#1',
      'ui-debug-surface:shellx-browser-workflow-preview@src/browser/components/BookmarkSidecar.tsx#15',
    ].includes(assignment.surfaceId))
    .map((assignment) => [assignment.surfaceId, assignment]),
);
assert.equal(browserShellPromotedAssignments.size, 10);
assert(
  [...browserShellPromotedAssignments.values()].every((assignment) => (
    !assignment.driverId.includes("backlog")
      && assignment.fixtureId === (assignment.surfaceId.includes("personal-lock")
        ? "ui:browser-personal-lock-owned-settings"
        : "ui:browser-workflow-preview-error-owned")
  )),
  "exact native PIN lock lifecycles and the missing-workflow Browser shell fixtures must enter executable lanes",
);
const bookmarkDragAssignment = loadedLiveDriverPlan.assignments.find((assignment) => (
  assignment.surfaceId === 'ui-control:src/browser/components/BookmarkSidecar.tsx:[data-debug-id^="shellx-browser-bookmark-drag-"]@src/browser/components/BookmarkSidecar.tsx#2'
));
assert.equal(bookmarkDragAssignment?.driverId, "ui-control-bounded-installed");
assert.equal(bookmarkDragAssignment?.fixtureId, "ui:browser-bookmark-owned-row");
assert.equal(bookmarkDragAssignment?.oracleId, "ui:activation:owned-bookmark-order-transition");
assert.equal(bookmarkDragAssignment?.cleanupId, "ui:delete-owned-bookmarks-restore-panel-abort-task-and-window");
const browserDelegationMarkerAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  [
    'ui-debug-surface:shellx-browser-handoff-tab@src/browser/components/BrowserChrome.tsx#8',
    'ui-debug-surface:shellx-browser-take-back-tab@src/browser/components/BrowserChrome.tsx#9',
  ].includes(assignment.surfaceId)
));
assert.equal(browserDelegationMarkerAssignments.length, 2);
assert(browserDelegationMarkerAssignments.every((assignment) => (
  assignment.driverId === "ui-debug-browser-delegation-installed"
    && assignment.fixtureId === "ui:browser-owned-tab-delegation-marker"
    && assignment.oracleId === "ui:activation:owned-browser-tab-delegation-marker"
    && assignment.cleanupId === "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window"
)), "both Browser delegation markers must use the exact native trusted handoff/take-back lifecycle");
const remoteCwdPromotedIds = [
  'ui-control:src/App.tsx:[data-debug-id="remote-cwd-close"]@src/App.tsx#1',
  'ui-control:src/App.tsx:[data-debug-id="remote-cwd-input"]@src/App.tsx#2',
  'ui-control:src/App.tsx:[data-debug-id="remote-cwd-go"]@src/App.tsx#3',
  'ui-control:src/App.tsx:[data-debug-id="remote-cwd-use"]@src/App.tsx#4',
  'ui-control:src/App.tsx:[data-debug-id="remote-cwd-up"]@src/App.tsx#5',
  'ui-control:src/App.tsx:[data-debug-id="remote-cwd-parent"]@src/App.tsx#6',
  'ui-control:src/App.tsx:[data-debug-id="remote-cwd-parent"]@src/App.tsx#7',
  'ui-control:src/App.tsx:[data-debug-id="remote-cwd-folder"]@src/App.tsx#8',
].sort();
const remoteCwdPromotedAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  remoteCwdPromotedIds.includes(assignment.surfaceId)
));
assert.deepEqual(remoteCwdPromotedAssignments.map((assignment) => assignment.surfaceId).sort(), remoteCwdPromotedIds);
assert(
  remoteCwdPromotedAssignments.every((assignment) => (
    assignment.driverId === "ui-control-bounded-installed"
      && assignment.fixtureId === "ui:remote-cwd-owned-local-tree"
      && assignment.cleanupId === "ui:close-remote-cwd-picker-delete-owned-tree"
      && !assignment.expectedEffect.startsWith("BUILDING:")
  )),
  "eight isolated Remote Folder draft, navigation, and owned-tab selection controls must use the disposable local-tree lifecycle",
);
const appBottomBuildingAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  assignment.fixtureId === "ui:app-bottom-excluded-provider-picker-session-capture-or-prompt-state"
));
assert.equal(appBottomBuildingAssignments.length, 0);
assert(
  appBottomBuildingAssignments.every((assignment) => (
    assignment.driverId === "ui-control-backlog-installed"
      && assignment.expectedEffect.startsWith("BUILDING: ")
      && assignment.expectedEffect.length > 140
      && assignment.cleanupId === "ui:not-invoked"
  )),
  "no app-bottom provider, operator-session, or microphone path may remain on the BUILDING ledger",
);
const slashHighlightAssignment = loadedLiveDriverPlan.assignments.find((assignment) => (
  assignment.surfaceId === "ui-debug-surface:surface-components-bottompanel-24@src/components/BottomPanel.tsx#23"
));
assert.equal(slashHighlightAssignment?.driverId, "ui-debug-surface-installed");
assert.equal(slashHighlightAssignment?.fixtureId, "ui:owned-slash-command-row-visible");
assert.equal(slashHighlightAssignment?.cleanupId, "ui:clear-debug-highlight-and-restore-owned-state");
const agentCliStatusAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  assignment.surfaceId.includes("@src/components/AgentCliStatusCard.tsx#")
));
assert.equal(agentCliStatusAssignments.length, 11);
assert.equal(
  agentCliStatusAssignments.filter((assignment) => (
    assignment.driverId === "ui-control-agent-cli-setup-lifecycle-installed"
      && assignment.fixtureId === "ui:agent-cli-status-owned-setup-open"
      && assignment.oracleId === "ui:activation:agent-cli-status-setup-dialog-opened"
      && assignment.cleanupId === "ui:close-agent-cli-status-dialog-and-restore-right-rail"
  )).length,
  5,
  "the five inert Agent CLI status setup controls must use the dedicated native open/filter lifecycle",
);
assert.equal(
  agentCliStatusAssignments.filter((assignment) => (
    assignment.driverId === "ui-debug-surface-installed"
      && assignment.fixtureId === "ui:agent-cli-status-owned-setup-controls-visible"
  )).length,
  5,
  "the five Agent CLI status markers must resolve without claiming activation",
);
assert(
  agentCliStatusAssignments.some((assignment) => (
    assignment.surfaceId.includes('role=button;name="Refresh"')
      && assignment.driverId === "ui-control-agent-cli-setup-lifecycle-installed"
      && assignment.fixtureId === "ui:agent-cli-owned-target-live-refresh"
      && assignment.oracleId === "ui:activation:agent-cli-fresh-version-observed"
      && assignment.cleanupId === "ui:close-agent-cli-live-scan-delete-owned-binary-restore-right-rail"
  )),
  "Agent CLI Refresh must prove a replaced owned CLI version through the isolated exact-target scan",
);
const connectionAgentCliSetupAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  assignment.surfaceId.includes("connection-agent-cli-setup-open")
));
assert.equal(connectionAgentCliSetupAssignments.length, 2);
assert(
  connectionAgentCliSetupAssignments.some((assignment) => (
    assignment.surfaceId.startsWith("ui-control:")
      && assignment.driverId === "ui-control-connection-lifecycle-installed"
      && assignment.fixtureId === "ui:owned-connection-record-local-probe"
      && assignment.oracleId === "ui:activation:owned-connection-agent-setup-opened"
      && assignment.cleanupId === "ui:close-connection-ui-delete-owned-record-restore-directory"
  )),
  "the connection-owned setup control must scan an isolated local target and open setup without preparing or confirming an install",
);
assert(
  connectionAgentCliSetupAssignments.some((assignment) => (
    assignment.surfaceId.startsWith("ui-debug-surface:")
      && assignment.driverId === "ui-debug-surface-installed"
      && assignment.fixtureId === "ui:owned-connection-editor-scanned-visible"
      && assignment.expectedEffect.includes("no control activation is claimed")
  )),
  "the connection-owned setup marker may remain addressable through its exact owned connection fixture without claiming activation",
);
assert.equal(
  loadedLiveDriverPlan.drivers.filter((driver) => driver.id.endsWith("-backlog-installed")).length,
  9,
  "every surface kind must have one explicit fail-closed building lane",
);
const debugApiDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "debug-api-route-installed.ts"),
  "utf8",
);
assert(
  loadedLiveDriverPlan.assignments.filter((assignment) => assignment.driverId === "debug-api-route-installed").length === 231
    && liveDriverPlan.counts.readyByKind["debug-api-route"] === 744
    && debugApiDriverSource.includes("prepareDebugApiSessionFixture(request)")
    && debugApiDriverSource.includes("cleanupDebugApiSessionFixture(sessionFixture)")
    && debugApiDriverSource.includes("prepareDebugApiFilesFixture(request)")
    && debugApiDriverSource.includes("cleanupDebugApiFilesFixture(filesFixture)")
    && debugApiDriverSource.includes("let routeSettleFixture: DebugApiBrowserSettleFixture | null = null")
    && debugApiDriverSource.includes('if (routePath(assignment) === "/browser/settle")')
    && debugApiDriverSource.includes("prepareDebugApiBrowserSettleFixture(connection)")
    && debugApiDriverSource.includes("cleanupDebugApiBrowserSettleFixture(connection, routeSettleFixture)")
    && debugApiDriverSource.includes("exerciseDebugApiBrowserEvidenceArtifactMutation(connection, request, assignment)")
    && debugApiDriverSource.includes("exerciseDebugApiBrowserWindowMutation(connection, assignment)")
    && debugApiDriverSource.includes("exerciseDebugApiBrowserPendingRequestMutation(connection, request, assignment)")
    && debugApiDriverSource.includes("exerciseDebugApiGoalLifecycleMutation(connection, request, assignment)")
    && debugApiDriverSource.includes("exerciseDebugApiVaultOpenPanelMutation(connection, assignment)")
    && debugApiDriverSource.includes("exerciseDebugApiProviderLifecycleMutation(connection, request, assignment)")
    && debugApiDriverSource.includes("exerciseDebugApiVaultAgentRequestMutation(connection, request, assignment)")
    && debugApiDriverSource.includes("exerciseDebugApiFsWatchMutation(connection, request, assignment)")
    && debugApiDriverSource.includes("exerciseDebugApiTauriInvokeRelayMutation(connection, assignment)")
    && debugApiDriverSource.includes("exerciseReleaseNativePickerLease(connection, request, assignment)")
    && debugApiDriverSource.includes("prepareDebugApiGitFixture(request)")
    && debugApiDriverSource.includes("cleanupDebugApiGitFixture(gitFixture)"),
  "the installed Debug API cohort must include bounded read fixtures, disposable owned mutations, operator and remote-approval gates, exact denials, and cleanup on all platforms",
);
const taskDebugApiDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "debug-api-task-installed.ts"),
  "utf8",
);
assert(
  loadedLiveDriverPlan.drivers.find((driver) => driver.id === "debug-api-task-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "debug-api-task-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "debug-api-task-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => assignment.driverId === "debug-api-task-installed").length === 17
    && taskDebugApiDriverSource.includes("assertIsolatedTaskReleaseProfile(request)")
    && taskDebugApiDriverSource.includes("verifyTaskProviderCatalogue")
    && taskDebugApiDriverSource.includes("task_run_not_available")
    && taskDebugApiDriverSource.includes("soft-deleted exactly the owned Task")
    && !taskDebugApiDriverSource.includes("start_provider_session")
    && !taskDebugApiDriverSource.includes("initiate_and_send_prompt"),
  "all seventeen Task Debug API routes must exercise approved agent creation, one isolated paused definition, exact state and receipt projections, pre-dispatch refusals, and truthful soft-delete cleanup on every shipped platform cell",
);
const tauriCommandDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "tauri-command-installed.ts"),
  "utf8",
);
assert(
  loadedLiveDriverPlan.drivers.find((driver) => driver.id === "tauri-command-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "tauri-command-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "tauri-command-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => assignment.driverId === "tauri-command-installed").length === 161
    && liveDriverPlan.counts.readyByKind["tauri-command"] === 540
    && tauriCommandDriverSource.includes('invocationTransport: "debug-api-direct"')
    && tauriCommandDriverSource.includes('"/release-test/tauri-invokes"')
    && tauriCommandDriverSource.includes('"DELETE"')
    && tauriCommandDriverSource.includes("cleanupActiveRelayInvokes(webdriver)")
    && !tauriCommandDriverSource.includes("window.__TAURI_INTERNALS__")
    && !tauriCommandDriverSource.includes("executeReleaseSurfaceWebDriverScript")
    && !tauriCommandDriverSource.includes("release-surface-webdriver-client")
    && tauriCommandDriverSource.includes("waitForVaultPanelVisibility(webdriver, true)")
    && tauriCommandDriverSource.includes('openModal: "close"')
    && tauriCommandDriverSource.includes("cleanupUserDataMutation(webdriver, userDataBaseline)")
    && tauriCommandDriverSource.includes("cleanupGoalState(webdriver, request, goalFixture)")
    && tauriCommandDriverSource.includes("verifyExpectedRejection(command, completed)")
    && tauriCommandDriverSource.includes("cleanupConnectionMutation(webdriver)")
    && tauriCommandDriverSource.includes("cleanupOutsideConnectorMutation(webdriver)")
    && tauriCommandDriverSource.includes("cleanupFileMutationFixture(fileFixture)")
    && tauriCommandDriverSource.includes("cleanupVaultMutation(webdriver, vaultFixture)")
    && tauriCommandDriverSource.includes("cleanupTokenRotationFixture(tokenRotationFixture)")
    && tauriCommandDriverSource.includes("cleanupScreenshotFixture(screenshotFixture)")
    && tauriCommandDriverSource.includes("cleanupGitMutationFixture(gitMutationFixture)")
    && tauriCommandDriverSource.includes("cleanupVaultPanel(webdriver, vaultPanelInvokedAtMs)")
    && tauriCommandDriverSource.includes("cleanupMarketplaceMutation(webdriver, marketplaceFixture)")
    && tauriCommandDriverSource.includes("cleanupVaultAgentStateFixture(vaultAgentStateFixture)")
    && tauriCommandDriverSource.includes("browserTeachWorkflowBookmarkId")
    && !tauriCommandDriverSource.includes("fixture-private"),
  "the one hundred sixty-one generic bounded Tauri IPC commands must use the authenticated isolated relay with exact fail-closed contracts or owned Windows desktop-integration, Browser engine/profile/session/history/Git/user-data/goal/media/Vault/connection/file/config/token/UI fixtures and delete, close, or restore temporary state on every shipped platform cell",
);
const taskTauriDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "tauri-command-task-installed.ts"),
  "utf8",
);
assert(
  loadedLiveDriverPlan.drivers.find((driver) => driver.id === "tauri-command-task-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "tauri-command-task-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "tauri-command-task-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => assignment.driverId === "tauri-command-task-installed").length === 20
    && taskTauriDriverSource.includes("ReleaseSurfaceTauriInvokeSession")
    && taskTauriDriverSource.includes("invokeExpectFailure")
    && taskTauriDriverSource.includes("tasks_persist_attachments")
    && taskTauriDriverSource.includes("tasks_reclaim_attachments")
    && taskTauriDriverSource.includes("ShellX Cut needs an active ShellX desktop-host context")
    && taskTauriDriverSource.includes("soft-deleted exactly the owned Task")
    && !taskTauriDriverSource.includes("start_provider_session")
    && !taskTauriDriverSource.includes("initiate_and_send_prompt")
    && !taskTauriDriverSource.includes("login")
    && !taskTauriDriverSource.includes("logout"),
  "all twenty Task and Cut Tauri commands must use the authenticated isolated relay, live target scan, exact paused definition and attachment lifecycle, pre-dispatch refusal contracts, and truthful cleanup on every shipped platform cell",
);
const cutToolingDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-cut-tooling-installed.ts"),
  "utf8",
);
const cutToolingControlDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-cut-tooling-installed.ts"),
  "utf8",
);
assert(
  loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-cut-tooling-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-cut-tooling-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-cut-tooling-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => assignment.driverId === "ui-control-cut-tooling-installed").length === 2
    && cutToolingControlDriverSource.includes('invocationTransport: "native-installed-input"')
    && cutToolingDriverSource.includes('relay.invoke("session_tooling_snapshot"')
    && cutToolingDriverSource.includes("data-shellx-cut-check-sequence='1'")
    && cutToolingDriverSource.includes("Open unavailable did not expose its exact disabled host-context explanation")
    && cutToolingDriverSource.includes("selectRightTab(connection, input, originalRightTab)")
    && !cutToolingDriverSource.includes("cut_tooling_open")
    && !cutToolingDriverSource.includes("start_provider_session")
    && !cutToolingDriverSource.includes("initiate_and_send_prompt"),
  "both Cut Tooling UI controls must use native installed input, a read-only no-host-context preflight, an exact visible refresh receipt, disabled Open verification, and right-rail restoration on every shipped platform cell",
);
const cutToolingStateAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  assignment.surfaceId.startsWith("ui-debug-surface:cut-tooling-state-")
));
assert.equal(cutToolingStateAssignments.length, CUT_TOOLING_STATES.length);
for (const state of CUT_TOOLING_STATES) {
  const assignment = cutToolingStateAssignments.find((row) => (
    row.surfaceId === `ui-debug-surface:cut-tooling-state-${state}@src/components/CutToolingRow.tsx#1`
  ));
  assert(
    assignment?.driverId === "ui-debug-surface-installed"
      && assignment.fixtureId === `ui:cut-tooling-${state}-visible`
      && assignment.oracleId === "ui:visible-nonempty-rectangle"
      && assignment.cleanupId === "ui:clear-debug-highlight-and-restore-owned-state",
    `Cut Tooling state ${state} must have an exact installed-app visible-state fixture`,
  );
}
assert(
  loadedLiveDriverPlan.assignments.filter((assignment) => assignment.driverId === "browser-cli-command-installed").length === 28
    && liveDriverPlan.counts.readyByKind["browser-cli-command"] === 87,
  "all help aliases, six installed reads, twelve owned-page actions, two bounded artifacts, two recipe workflows, one isolated rendered check, and two Flight Recorder Browser CLI commands must remain exact three-platform rows",
);
const hostMcpDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "host-mcp-tool-installed.ts"),
  "utf8",
);
const hostMcpVaultLifecycleSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "host-mcp-vault-lifecycle.ts"),
  "utf8",
);
assert(
  loadedLiveDriverPlan.drivers.find((driver) => driver.id === "host-mcp-tool-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "host-mcp-tool-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "host-mcp-tool-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => assignment.driverId === "host-mcp-tool-installed").length === 106
    && liveDriverPlan.counts.readyByKind["host-mcp-tool"] === 324
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "host-mcp:installed-vault-e2e-browser-lifecycle"
      && assignment.cleanupId === "host-mcp:reset-isolated-vault-close-owned-browser-task-and-restore-autonomy"
      && assignment.oracleId.endsWith(":installed-mutation-effect")
    )).length === 3
    && hostMcpDriverSource.includes("resolveReleaseSurfaceRuntimeCandidate(request)")
    && hostMcpDriverSource.includes('mcpRequest(connection, "tools/call"')
    && hostMcpDriverSource.includes("cleanupFixtures(fixtures)")
    && hostMcpVaultLifecycleSource.includes("browser_agent_wallet_checkout_unavailable")
    && hostMcpVaultLifecycleSource.includes("/vault/e2e/reset")
    && hostMcpVaultLifecycleSource.includes("secretPresent !== true")
    && !hostMcpDriverSource.includes("fixture-private"),
  "one hundred six bounded Host MCP reads, writes, Browser, Preview, Tasks, and isolated Vault effects, metadata operations, exact artifact lifecycles, and pre-effect safety refusals must bind the exact candidate, prove all compact gateways and searchable hidden tools, use authenticated tools/call, avoid user or external mutation, and clean owned fixtures on all platforms",
);
assert(
  loadedLiveDriverPlan.drivers.find((driver) => driver.id === "palette-action-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "palette-action-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "palette-action-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => assignment.driverId === "palette-action-installed").length === 14
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "palette-action-provider-action-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "palette-action-provider-action-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "palette-action-provider-action-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => assignment.driverId === "palette-action-provider-action-installed").length === 1
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "palette-action-native-picker-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "palette-action-native-picker-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "palette-action-native-picker-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => assignment.driverId === "palette-action-native-picker-installed").length === 1
    && liveDriverPlan.counts.readyByKind["palette-action"] === 48,
  "all sixteen palette actions, including the isolated native-picker contract, remain ready on all three platforms",
);
const paletteDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "palette-action-installed.ts"),
  "utf8",
);
const ownedScreenshotAttachmentSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "owned-screenshot-attachment.ts"),
  "utf8",
);
assert(
  paletteDriverSource.includes('invocationTransport: "native-installed-input"')
    && paletteDriverSource.includes("createReleaseSurfaceInstalledInputSession")
    && paletteDriverSource.includes("clickReleaseSurfaceWebDriverElement")
    && paletteDriverSource.includes("cleanupOwnedScreenshotAttachmentProof")
    && ownedScreenshotAttachmentSource.includes("observeReleaseSurfaceInstalledInputElement")
    && ownedScreenshotAttachmentSource.includes("screenshot proof run-profile marker does not match")
    && !paletteDriverSource.includes("executeReleaseSurfaceInstalledInputScript")
    && !paletteDriverSource.includes("debugClick:"),
  "palette actions must use platform-native installed-input clicks rather than synthetic Debug API clicks",
);
assert(
  loadedLiveDriverPlan.drivers.find((driver) => driver.id === "keyboard-shortcut-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "keyboard-shortcut-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "keyboard-shortcut-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => assignment.driverId === "keyboard-shortcut-installed").length === 11
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "keyboard-shortcut-native-picker-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "keyboard-shortcut-native-picker-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "keyboard-shortcut-native-picker-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => assignment.driverId === "keyboard-shortcut-native-picker-installed").length === 1
    && liveDriverPlan.counts.readyByKind["keyboard-shortcut"] === 36,
  "all twelve native keyboard rows, including the isolated native-picker contract, remain ready on all three platforms",
);
const keyboardDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "keyboard-shortcut-installed.ts"),
  "utf8",
);
assert(
  keyboardDriverSource.includes('invocationTransport: "native-installed-input"')
    && keyboardDriverSource.includes("observeReleaseSurfaceInstalledInputElement")
    && keyboardDriverSource.includes('debugRendererFixture: { id: "keyboard-diff-lifecycle" }')
    && keyboardDriverSource.includes('debugRendererFixture: { id: "keyboard-diff-lifecycle", action: "clear" }')
    && keyboardDriverSource.includes('"src/lib/debug-renderer-fixture.ts"')
    && !keyboardDriverSource.includes("refreshPastChats: true")
    && !keyboardDriverSource.includes('kind: "provider-session-event"')
    && !keyboardDriverSource.includes("executeReleaseSurfaceInstalledInputScript")
    && !keyboardDriverSource.includes("window.location.reload"),
  "keyboard shortcuts must use native chords plus bounded observations and an owned renderer-only diff fixture without arbitrary renderer scripts or session-file races",
);
const shellxCommandDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "shellx-command-installed.ts"),
  "utf8",
);
assert(
  loadedLiveDriverPlan.drivers.find((driver) => driver.id === "shellx-command-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "shellx-command-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "shellx-command-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => assignment.driverId === "shellx-command-installed").length === 7
    && liveDriverPlan.counts.readyByKind["shellx-command"] === 21
    && shellxCommandDriverSource.includes('invocationTransport: "native-installed-input"')
    && shellxCommandDriverSource.includes("createReleaseSurfaceInstalledInputSession")
    && shellxCommandDriverSource.includes("setReleaseSurfaceWebDriverElementValue")
    && shellxCommandDriverSource.includes("clearReleaseSurfaceWebDriverElement")
    && shellxCommandDriverSource.includes("clickReleaseSurfaceWebDriverElement")
    && shellxCommandDriverSource.includes("/goal/state?tabId=")
    && shellxCommandDriverSource.includes('debugPost(connection, "/goal/start"')
    && shellxCommandDriverSource.includes("cleanupGoalCommandFixture")
    && !shellxCommandDriverSource.includes("executeReleaseSurfaceInstalledInputScript")
    && !shellxCommandDriverSource.includes("window.__TAURI_INTERNALS__"),
  "seven ShellX commands must use native composer events, exact visible or authenticated Goal-state oracles, and owned cleanup on all three platforms",
);
const uiControlDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-installed.ts"),
  "utf8",
);
const permissionDecisionDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-permission-decision-lifecycle.ts"),
  "utf8",
);
const permissionDecisionFixtureSource = readFileSync(
  resolve(root, "src", "lib", "debug-permission-decision-fixture.ts"),
  "utf8",
);
const permissionPillSource = readFileSync(
  resolve(root, "src", "components", "PermissionPill.tsx"),
  "utf8",
);
const permissionAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  assignment.surfaceId.includes("@src/components/PermissionPill.tsx")
));
const permissionControlAssignments = permissionAssignments.filter((assignment) => (
  assignment.driverId === "ui-control-permission-decision-lifecycle-installed"
));
const permissionPillMarkerAssignments = permissionAssignments.filter((assignment) => (
  assignment.driverId === "ui-debug-surface-installed"
));
assert(
  permissionAssignments.length === 5
    && permissionControlAssignments.length === 3
    && permissionPillMarkerAssignments.length === 2
    && permissionAssignments.every((assignment) => !assignment.driverId.endsWith("-backlog-installed"))
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-permission-decision-lifecycle-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-permission-decision-lifecycle-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-permission-decision-lifecycle-installed")?.platforms["linux-installed"] === "ready",
  "all five PermissionPill source surfaces must use exact installed coverage on every platform",
);
assert(
  permissionControlAssignments.every((assignment) => (
    assignment.fixtureId.startsWith("ui:permission-owned-")
      && assignment.cleanupId === "ui:clear-owned-permission-decision-and-restore-view"
      && assignment.oracleId.startsWith("ui:activation:permission-")
  ))
    && permissionPillMarkerAssignments.every((assignment) => (
      assignment.fixtureId === "ui:owned-renderer-event-chat-visible"
        && assignment.cleanupId === "ui:clear-debug-highlight-and-restore-owned-state"
        && assignment.oracleId === "ui:visible-nonempty-rectangle"
    )),
  "permission decision and pill marker assignments must retain their exact action-specific fixtures and cleanup",
);
assert(
  permissionDecisionDriverSource.includes("clickReleaseSurfaceInstalledInputElement")
    && permissionDecisionDriverSource.includes("Permission decision receipt")
    && permissionDecisionDriverSource.includes("restore exact active-tab and bottom-tab memory")
    && !permissionDecisionDriverSource.includes("executeReleaseSurfaceInstalledInputScript")
    && !permissionDecisionDriverSource.includes("navigator.clipboard")
    && !permissionDecisionDriverSource.includes("writeFile")
    && !permissionDecisionDriverSource.includes("sendPrompt")
    && !permissionDecisionDriverSource.includes('invoke("')
    && permissionDecisionFixtureSource.includes("fixtureOnly: true")
    && permissionDecisionFixtureSource.includes("Unknown commands are")
    && !permissionDecisionFixtureSource.includes("@tauri-apps")
    && !existsSync(resolve(root, "src", "components", "PermissionModal.tsx"))
    && permissionPillSource.includes("debugFixture.expectedDecision !== decision")
    && permissionPillSource.includes('invoke<boolean>("resolve_permission_request"'),
  "permission fixtures must stay fail-closed and renderer-only while production callbacks retain the normal Tauri resolution path",
);
const installedBrowserFixtureDriverSources = [
  uiControlDriverSource,
  readFileSync(resolve(root, "scripts", "release-drivers", "ui-debug-surface-installed.ts"), "utf8"),
  readFileSync(resolve(root, "scripts", "release-drivers", "ui-control-owned-browser-bookmarks.ts"), "utf8"),
  readFileSync(resolve(root, "scripts", "release-drivers", "ui-control-owned-browser-history.ts"), "utf8"),
  readFileSync(resolve(root, "scripts", "release-drivers", "ui-control-browser-personal-lock-settings.ts"), "utf8"),
  readFileSync(resolve(root, "scripts", "release-drivers", "ui-control-owned-browser-bookmark-navigation.ts"), "utf8"),
];
assert(
  installedBrowserFixtureDriverSources.every((source) => (
    source.includes('autonomy: "assistedAutonomous"')
    && !source.includes('autonomy: "approvalFirst"')
  )),
  "installed Browser release fixtures must request only the enforced assistedAutonomous policy",
);
const bottomTabsDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-bottom-tabs.ts"),
  "utf8",
);
const bottomPanelLifecycleDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-bottom-panel-lifecycle.ts"),
  "utf8",
);
const boundedInstalledDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-bounded-installed.ts"),
  "utf8",
);
const boundedInstalledAssignmentsSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-bounded-installed-assignments.ts"),
  "utf8",
);
const connectionLifecycleDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-connection-lifecycle.ts"),
  "utf8",
);
const navigationTabsDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-navigation-tabs.ts"),
  "utf8",
);
const sessionTabsLifecycleDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-session-tabs-lifecycle.ts"),
  "utf8",
);
const tasksPanelLifecycleDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-tasks-panel-lifecycle.ts"),
  "utf8",
);
const chatOutputLifecycleDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-chat-output-lifecycle.ts"),
  "utf8",
);
const chatOutputJumpDebugDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-debug-chat-output-jump-lifecycle-installed.ts"),
  "utf8",
);
const rightRailGitReadLifecycleDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-right-rail-git-read-lifecycle.ts"),
  "utf8",
);
const rightRailGitReadFixtureSource = readFileSync(
  resolve(root, "src", "lib", "debug-right-rail-git-fixture.ts"),
  "utf8",
);
const rightRailGitWriteLifecycleDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-right-rail-git-write-lifecycle.ts"),
  "utf8",
);
const rightRailGitReadAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  assignment.driverId === "ui-control-right-rail-git-read-lifecycle-installed"
));
const rightRailGitExcludedAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  assignment.fixtureId === "ui:right-rail-git-excluded-network-provider-clipboard-file-or-repository-state"
));
const rightRailGitWriteAssignments = loadedLiveDriverPlan.assignments.filter((assignment) => (
  assignment.driverId === "ui-control-right-rail-git-write-lifecycle-installed"
));
assert(
  loadedLiveDriverPlan.drivers.find((driver) => (
    driver.id === "ui-control-right-rail-git-read-lifecycle-installed"
    && driver.platforms["windows-installed"] === "ready"
    && driver.platforms["macos-installed"] === "ready"
    && driver.platforms["linux-installed"] === "ready"
  )) !== undefined
    && rightRailGitReadAssignments.length === 6
    && rightRailGitReadAssignments.every((assignment) => (
      assignment.fixtureId === "ui:right-rail-git-owned-read-lifecycle"
      && assignment.cleanupId === "ui:clear-owned-right-rail-git-fixture-and-restore-right-rail"
    )),
  "exactly six renderer-owned RightRail/GitPane reads must use the dedicated native installed lifecycle on every platform",
);
assert(
  rightRailGitExcludedAssignments.length === 0
    && rightRailGitExcludedAssignments.every((assignment) => (
      assignment.driverId.endsWith("-backlog-installed")
      && assignment.expectedEffect.startsWith("BUILDING: ")
      && assignment.cleanupId === "ui:not-invoked"
      && assignment.oracleId.includes("building-blocker")
    )),
  "no RightRail or GitPane read action may remain in the BUILDING backlog",
);
assert(
  loadedLiveDriverPlan.drivers.find((driver) => (
    driver.id === "ui-control-right-rail-git-write-lifecycle-installed"
    && driver.platforms["windows-installed"] === "ready"
    && driver.platforms["macos-installed"] === "ready"
    && driver.platforms["linux-installed"] === "ready"
  )) !== undefined
    && rightRailGitWriteAssignments.length === 2
    && rightRailGitWriteAssignments.every((assignment) => (
      assignment.fixtureId === "ui:right-rail-git-owned-write-lifecycle"
      && assignment.cleanupId === "ui:remove-owned-checkpoint-worktree-branch-and-repository-restore-right-rail"
      && !assignment.expectedEffect.startsWith("BUILDING:")
    )),
  "Checkpoint and Worktree must use the real disposable repository lifecycle on every installed platform",
);
assert(
  rightRailGitWriteLifecycleDriverSource.includes("ui-right-rail-git-write-lifecycle")
    && rightRailGitWriteLifecycleDriverSource.includes("git-checkpoints")
    && rightRailGitWriteLifecycleDriverSource.includes('"worktree", "remove", "--force"')
    && rightRailGitWriteLifecycleDriverSource.includes('"branch", "-D"')
    && rightRailGitWriteLifecycleDriverSource.includes("baselineCheckpointDirs")
    && rightRailGitWriteLifecycleDriverSource.includes("baselineWorktrees")
    && rightRailGitWriteLifecycleDriverSource.includes("waitForUiState")
    && !rightRailGitWriteLifecycleDriverSource.includes("shell: true"),
  "the Git write lifecycle must stay confined to an owned repository, prove exact artifacts, and restore branch, worktree, checkpoint, and UI state",
);
assert(
  rightRailGitReadLifecycleDriverSource.includes('debugRendererFixture: { id: "right-rail-git-lifecycle" }')
    && rightRailGitReadLifecycleDriverSource.includes('debugRendererFixture: { id: "right-rail-git-lifecycle", action: "clear" }')
    && rightRailGitReadLifecycleDriverSource.includes("observeReleaseSurfaceInstalledInputElement")
    && !rightRailGitReadLifecycleDriverSource.includes("executeReleaseSurfaceInstalledInputScript")
    && !rightRailGitReadLifecycleDriverSource.includes("navigator.clipboard")
    && !rightRailGitReadLifecycleDriverSource.includes("writeFile")
    && !rightRailGitReadLifecycleDriverSource.includes("openExternal")
    && !rightRailGitReadLifecycleDriverSource.includes("sendPrompt")
    && !rightRailGitReadLifecycleDriverSource.includes('invoke("')
    && rightRailGitReadFixtureSource.includes("fixtureOnly: true")
    && rightRailGitReadFixtureSource.includes("release-owned-renderer-fixture")
    && !rightRailGitReadFixtureSource.includes("@tauri-apps")
    && !rightRailGitReadFixtureSource.includes("navigator.clipboard"),
  "the RightRail/GitPane lifecycle must remain renderer-only, bounded, and free of native state mutation",
);
const groupingSource = readFileSync(resolve(root, "src", "lib", "grouping.ts"), "utf8");
const localDisclosuresDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-local-disclosures.ts"),
  "utf8",
);
const agentCliSetupLifecycleDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-agent-cli-setup-lifecycle.ts"),
  "utf8",
);
const vaultOwnedEditDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-vault-owned-edit.ts"),
  "utf8",
);
const activityBrowserLifecycleDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-activity-browser-lifecycle.ts"),
  "utf8",
);
const shellxagentLifecycleDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-shellxagent-lifecycle.ts"),
  "utf8",
);
const remoteCwdLifecycleDriverSource = readFileSync(
  resolve(root, "scripts", "release-drivers", "ui-control-remote-cwd-lifecycle.ts"),
  "utf8",
);
const vaultTabSource = readFileSync(
  resolve(root, "src", "components", "settings", "VaultTab.tsx"),
  "utf8",
);
assert(
  !loadedLiveDriverPlan.drivers.some((driver) => driver.id === "ui-control-installed")
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-bounded-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-bounded-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-bounded-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => assignment.driverId === "ui-control-bounded-installed").length === 369
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-bottom-tabs-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-bottom-tabs-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-bottom-tabs-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-bottom-tabs-installed"
      && assignment.fixtureId === "ui:bottom-tab-opposite-baseline"
    )).length === 6
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-bottom-panel-lifecycle-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-bottom-panel-lifecycle-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-bottom-panel-lifecycle-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-bottom-panel-lifecycle-installed"
      && assignment.fixtureId.startsWith("ui:bottom-panel-owned-tab-")
      && assignment.cleanupId.includes("restore-baseline")
    )).length === 8
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-connection-lifecycle-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-connection-lifecycle-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-connection-lifecycle-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => assignment.driverId === "ui-control-connection-lifecycle-installed").length === 15
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-navigation-tabs-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-navigation-tabs-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-navigation-tabs-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-navigation-tabs-installed"
      && (assignment.fixtureId === "ui:settings-tab-opposite-baseline"
        || assignment.fixtureId === "ui:right-rail-tab-opposite-baseline")
    )).length === 14
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-session-tabs-lifecycle-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-session-tabs-lifecycle-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-session-tabs-lifecycle-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-session-tabs-lifecycle-installed"
      && assignment.fixtureId === "ui:session-tabs-owned-multi-tab-lifecycle"
      && assignment.cleanupId === "ui:delete-owned-session-tabs-and-restore-baseline"
    )).length === 12
    && sessionTabsLifecycleDriverSource.includes("scrollLeft")
    && sessionTabsLifecycleDriverSource.includes("baseline.openTabs")
    && !sessionTabsLifecycleDriverSource.includes("executeReleaseSurfaceInstalledInputScript")
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-tasks-panel-lifecycle-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-tasks-panel-lifecycle-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-tasks-panel-lifecycle-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-tasks-panel-lifecycle-installed"
      && assignment.fixtureId === "ui:tasks-panel-owned-process-lifecycles"
      && assignment.cleanupId === "ui:kill-owned-processes-and-restore-tasks-view"
    )).length === 6
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:tasks-panel-excluded-provider-clipboard-or-operator-state"
      && assignment.expectedEffect.startsWith("BUILDING: ")
      && assignment.cleanupId === "ui:not-invoked"
    )).length === 0
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-chat-output-lifecycle-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-chat-output-lifecycle-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-chat-output-lifecycle-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-chat-output-lifecycle-installed"
      && assignment.fixtureId === "ui:chat-output-owned-renderer-lifecycle"
      && assignment.cleanupId === "ui:clear-owned-chat-output-events-close-preview-delete-files-and-restore-view"
    )).length === 6
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:chat-output-excluded-clipboard-state"
      && assignment.expectedEffect.startsWith("BUILDING: ")
      && assignment.cleanupId === "ui:not-invoked"
    )).length === 0
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-debug-chat-output-jump-lifecycle-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-debug-chat-output-jump-lifecycle-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-debug-chat-output-jump-lifecycle-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-debug-chat-output-jump-lifecycle-installed"
      && assignment.fixtureId === "ui:chat-output-owned-native-scroll-marker"
      && assignment.cleanupId === "ui:clear-owned-chat-output-scroll-marker-and-restore-view"
    )).length === 1
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-local-disclosures-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-local-disclosures-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-local-disclosures-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => assignment.driverId === "ui-control-local-disclosures-installed").length === 18
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-browser-shields-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-browser-shields-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-browser-shields-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-vault-owned-edit-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-vault-owned-edit-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-vault-owned-edit-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-vault-owned-edit-installed"
    )).length === 26
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-vault-owned-edit-installed"
      && assignment.cleanupId === "ui:delete-exact-owned-vault-key-restore-redacted-directory-and-settings"
    )).length === 16
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-vault-owned-edit-installed"
      && assignment.cleanupId === "ui:delete-exact-owned-vault-resources-clear-sensitive-drafts-and-restore-settings"
    )).length === 10
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-activity-browser-lifecycle-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-activity-browser-lifecycle-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-activity-browser-lifecycle-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-activity-browser-lifecycle-installed"
      && assignment.fixtureId === "ui:activity-browser-owned-session-file"
      && assignment.cleanupId === "ui:close-owned-activity-preview-and-tab-delete-exact-fixture-restore-baseline"
    )).length === 8
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-modal-backdrops-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-modal-backdrops-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-modal-backdrops-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-modal-backdrops-installed"
      && assignment.fixtureId.startsWith("ui:modal-backdrop-")
    )).length === 12
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:connectors-unsaved-draft-baseline"
    )).length === 13
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:attachment-media-owned-lifecycle"
      && assignment.driverId === "ui-control-bounded-installed"
      && assignment.cleanupId === "ui:clear-owned-attachment-media-and-delete-root"
    )).length === 16
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:attachment-media-excluded-native-or-prompt-path"
      && assignment.expectedEffect.startsWith("BUILDING:")
      && assignment.cleanupId === "ui:not-invoked"
    )).length === 0
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:plugins-owned-local-draft"
      && assignment.cleanupId === "ui:clear-owned-plugin-draft-and-fixture"
    )).length === 3
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-plugins-production-installed"
      && assignment.fixtureId === "ui:plugins-owned-production-profile"
      && assignment.cleanupId === "ui:restore-owned-plugin-config-delete-synthetic-vault-key-and-close-modal"
    )).length === 6
    && loadedLiveDriverPlan.assignments.every((assignment) => (
      assignment.fixtureId !== "ui:plugins-excluded-marketplace-or-vault-mutation"
    ))
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:build-plan-review-owned-inert"
      && assignment.oracleId === "ui:activation:build-plan-review-dismissed"
      && assignment.cleanupId === "ui:clear-owned-build-plan-review-and-restore-right-rail"
    )).length === 2
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:build-plan-review-excluded-live-build-mutation"
      && assignment.expectedEffect.startsWith("BUILDING:")
      && assignment.oracleId.endsWith(":building-blocker")
      && assignment.cleanupId === "ui:not-invoked"
    )).length === 0
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      (assignment.fixtureId === "ui:build-plan-review-owned-approve"
        || assignment.fixtureId === "ui:build-plan-review-owned-reject")
      && assignment.oracleId === "ui:activation:build-run-cockpit-owned-state-transition"
      && assignment.cleanupId === "ui:clear-owned-build-run-project-provider-git-and-restore-view"
    )).length === 2
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:shellxagent-owned-safe-token"
      && assignment.oracleId === "ui:boolean-state-transition"
      && assignment.cleanupId === "ui:hide-owned-shellxagent-token-close-settings-and-clear-fixture"
    )).length === 1
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:shellxagent-excluded-clipboard-or-live-token-mutation"
      && assignment.expectedEffect.startsWith("BUILDING:")
      && assignment.oracleId.endsWith(":building-blocker")
      && assignment.cleanupId === "ui:not-invoked"
    )).length === 0
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:shellxagent-isolated-token-rotation"
      && assignment.oracleId === "ui:activation:shellxagent-token-file-rotated"
      && assignment.cleanupId === "ui:restore-isolated-shellxagent-token-mode-and-settings"
    )).length === 1
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:connectors-draft-closed"
      && assignment.oracleId === "ui:activation:connectors-draft-opened"
      && assignment.cleanupId === "ui:restore-connectors-draft-and-close-settings"
    )).length === 1
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:connectors-unsaved-draft-open"
      && assignment.oracleId === "ui:activation:connectors-draft-closed"
      && assignment.cleanupId === "ui:restore-connectors-draft-and-close-settings"
    )).length === 1
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:connectors-owned-renderer-fixture"
      && assignment.cleanupId === "ui:clear-connectors-owned-fixture-and-close-settings"
    )).length === 4
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:connectors-excluded-provider-vault-session-or-operator-state"
      && assignment.expectedEffect.startsWith("BUILDING:")
      && assignment.cleanupId === "ui:not-invoked"
    )).length === 0
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-connectors-production-lifecycle-installed"
      && assignment.fixtureId.startsWith("ui:connectors-production-owned-")
      && assignment.cleanupId === "ui:delete-owned-connectors-reset-isolated-vault-restore-settings-and-teardown-profile"
    )).length === 5
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:connector-inbox-manual-refresh-baseline"
      && assignment.oracleId === "ui:activation:connector-inbox-manual-refresh"
      && assignment.cleanupId === "ui:reset-connector-inbox-refresh-receipt-and-close"
    )).length === 1
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:shellx-tool-exposure-owned-baseline"
    )).length === 1
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-bounded-installed"
      && (assignment.fixtureId === "ui:right-rail-owned-goal-awaiting-review"
        || assignment.fixtureId === "ui:right-rail-owned-goal-active")
      && assignment.cleanupId === "ui:forget-owned-goal-delete-cwd-and-restore-right-rail"
    )).length === 3
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-bounded-installed"
      && assignment.fixtureId === "ui:files-pane-owned-tree"
      && assignment.cleanupId === "ui:remove-owned-files-attachments-close-preview-delete-tree-and-restore-state"
    )).length === 7
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:vault-unsaved-draft-text-baseline"
      || assignment.fixtureId === "ui:vault-unsaved-draft-choice-baseline"
    )).length === 39
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:browser-bookmark-owned-row"
      || assignment.fixtureId === "ui:browser-bookmark-owned-folder-choice"
      || assignment.fixtureId === "ui:browser-bookmark-owned-create"
    )).length === 8
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:browser-owned-tab-create"
      || assignment.fixtureId === "ui:browser-owned-tab-row"
      || assignment.fixtureId === "ui:browser-owned-home-navigation"
      || assignment.fixtureId === "ui:browser-owned-history-navigation"
      || assignment.fixtureId === "ui:browser-owned-tab-lock"
      || assignment.fixtureId === "ui:browser-owned-tab-delegation"
    )).length === 13
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-browser-shields-installed"
      && assignment.fixtureId === "ui:browser-shields-owned-task"
    )).length === 8
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-bounded-installed"
      && assignment.fixtureId === "ui:browser-ad-mode-owned-task-default"
      && assignment.oracleId === "ui:boolean-state-transition"
      && assignment.cleanupId === "ui:restore-browser-ad-mode-default-abort-task-and-window"
    )).length === 4
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-bounded-installed"
      && assignment.fixtureId === "ui:browser-owned-history-sidecar"
      && assignment.cleanupId === "ui:clear-owned-browser-history-abort-task-and-window-loopback"
    )).length === 2
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-bounded-installed"
      && assignment.fixtureId === "ui:browser-personal-lock-owned-settings"
      && assignment.cleanupId === "ui:restore-browser-personal-lock-settings-abort-task-and-window"
    )).length === 14
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-bounded-installed"
      && assignment.fixtureId === "ui:browser-bookmark-owned-navigation"
      && assignment.cleanupId === "ui:delete-owned-bookmark-navigation-abort-task-and-window-loopback"
    )).length === 6
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:work-preview-owned-static-project"
    )).length === 1
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:work-preview-kind-auto-baseline"
    )).length === 4
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:work-preview-owned-running-project"
    )).length === 9
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:work-preview-owned-running-project"
      && assignment.driverId === "ui-control-bounded-installed"
    )).length === 9
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:work-preview-owned-running-project"
      && assignment.driverId === "ui-control-installed"
    )).length === 0
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:work-preview-log-default-baseline"
    )).length === 1
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-bounded-installed"
      && assignment.fixtureId === "ui:work-preview-log-default-baseline"
    )).length === 1
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:work-preview-owned-refresh"
      || assignment.fixtureId === "ui:work-preview-owned-doctor"
      || assignment.fixtureId === "ui:preview-center-owned-file-and-work"
    )).length === 4
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-bounded-installed"
      && assignment.fixtureId === "ui:preview-center-owned-file-and-work"
    )).length === 2
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-bounded-installed"
      && (assignment.fixtureId === "ui:work-preview-owned-refresh"
        || assignment.fixtureId === "ui:work-preview-owned-doctor")
    )).length === 2
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:file-preview-owned-html-mode"
    )).length === 2
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.fixtureId === "ui:find-owned-session-new-tab"
      && assignment.oracleId === "ui:activation:find-owned-session-new-tab"
      && assignment.cleanupId === "ui:close-owned-session-tab-delete-history-and-restore-baseline"
    )).length === 1
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-left-rail-lifecycle-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-left-rail-lifecycle-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-left-rail-lifecycle-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-left-rail-lifecycle-installed"
      && assignment.fixtureId === "ui:left-rail-owned-lifecycle"
      && assignment.cleanupId === "ui:restore-left-rail-titles-assignments-active-tab-close-owned-tabs-delete-owned-project-and-jsonl"
    )).length === 24
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-connection-lifecycle-installed"
      && assignment.cleanupId === "ui:close-connection-ui-delete-owned-record-restore-directory"
    )).length === 15
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-branch-picker-lifecycle-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-branch-picker-lifecycle-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-branch-picker-lifecycle-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-branch-picker-lifecycle-installed"
      && assignment.fixtureId === "ui:owned-branch-picker-selection"
      && assignment.cleanupId === "ui:close-owned-branch-picker-tab-delete-temp-git-and-restore-baseline"
    )).length === 1
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-agent-cli-setup-lifecycle-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-agent-cli-setup-lifecycle-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-agent-cli-setup-lifecycle-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-agent-cli-setup-lifecycle-installed"
      && assignment.fixtureId === "ui:agent-cli-setup-owned-dialog-open"
      && assignment.cleanupId === "ui:close-agent-cli-setup-owned-dialog"
    )).length === 2
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-agent-cli-setup-lifecycle-installed"
      && assignment.fixtureId === "ui:agent-cli-status-owned-setup-open"
      && assignment.cleanupId === "ui:close-agent-cli-status-dialog-and-restore-right-rail"
    )).length === 5
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-agent-cli-setup-lifecycle-installed"
      && assignment.fixtureId === "ui:agent-cli-owned-target-live-refresh"
      && assignment.cleanupId === "ui:close-agent-cli-live-scan-delete-owned-binary-restore-right-rail"
    )).length === 2
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-agent-cli-setup-lifecycle-installed"
      && assignment.fixtureId === "ui:agent-cli-owned-npm-install-lifecycle"
      && assignment.cleanupId === "ui:cancel-agent-cli-preparation-close-dialog-delete-owned-shim-and-receipt"
    )).length === 3
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-agent-cli-setup-lifecycle-installed"
      && assignment.fixtureId.startsWith("ui:agent-cli-owned-doc-link-")
      && assignment.oracleId === "ui:activation:agent-cli-doc-link-dispatched"
      && assignment.cleanupId === "ui:close-agent-cli-setup-owned-dialog"
    )).length === 2
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-agent-cli-setup-lifecycle-installed"
    )).length === 14
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-clipboard-lifecycle-installed")?.platforms["windows-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-clipboard-lifecycle-installed")?.platforms["macos-installed"] === "ready"
    && loadedLiveDriverPlan.drivers.find((driver) => driver.id === "ui-control-clipboard-lifecycle-installed")?.platforms["linux-installed"] === "ready"
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-clipboard-lifecycle-installed"
      && assignment.fixtureId === "ui:owned-native-clipboard-empty-lifecycle"
      && assignment.oracleId === "ui:activation:native-clipboard-owned-value-verified-and-cleared"
      && assignment.cleanupId === "ui:clear-owned-clipboard-prove-empty-and-restore-surface"
    )).length === 20
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-native-picker-lifecycle-installed"
    )).length === 7
    && loadedLiveDriverPlan.assignments.filter((assignment) => (
      assignment.driverId === "ui-control-screenshot-attachment-installed"
        && assignment.fixtureId === "ui:isolated-profile-empty-composer-screenshot"
        && assignment.oracleId === "ui:activation:owned-app-screenshot-attached"
        && assignment.cleanupId === "ui:remove-exact-screenshot-attachment-delete-owned-png-restore-view"
    )).length === 2
    && liveDriverPlan.counts.readyByKind["ui-control"] === 2_084
    && uiControlDriverSource.includes('invocationTransport: "native-installed-input"')
    && uiControlDriverSource.includes("createReleaseSurfaceInstalledInputSession")
    && uiControlDriverSource.includes("clickReleaseSurfaceWebDriverElement")
    && uiControlDriverSource.includes("clearReleaseSurfaceWebDriverElement")
    && uiControlDriverSource.includes('switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser")')
    && !uiControlDriverSource.includes("debugClick:")
    && bottomTabsDriverSource.includes("clickReleaseSurfaceInstalledInputElement")
    && bottomTabsDriverSource.includes("waitForBottomTab")
    && !bottomTabsDriverSource.includes("executeReleaseSurfaceInstalledInputScript")
    && !bottomTabsDriverSource.includes("window.__TAURI_INTERNALS__")
    && bottomPanelLifecycleDriverSource.includes("createOwnedTab")
    && bottomPanelLifecycleDriverSource.includes("prepareOwnedFiles")
    && bottomPanelLifecycleDriverSource.includes("debugRendererFixture")
    && bottomPanelLifecycleDriverSource.includes("observeReleaseSurfaceInstalledInputElement")
    && !bottomPanelLifecycleDriverSource.includes("expectedTerminalBaseline")
    && !bottomPanelLifecycleDriverSource.includes("ACP terminal")
    && !bottomPanelLifecycleDriverSource.includes("executeReleaseSurfaceInstalledInputScript")
    && !bottomPanelLifecycleDriverSource.includes("window.__TAURI_INTERNALS__")
    && boundedInstalledDriverSource.includes("assertBoundedInstalledUiControlAssignments")
    && boundedInstalledAssignmentsSource.includes("refuses non-allowlisted surfaces")
    && boundedInstalledAssignmentsSource.includes("UI_CONTROL_BOUNDED_INSTALLED_SURFACE_NAMES")
    && !boundedInstalledDriverSource.includes("executeReleaseSurfaceInstalledInputScript")
    && !boundedInstalledDriverSource.includes("acceptReleaseSurfaceInstalledInputAlert")
    && connectionLifecycleDriverSource.includes("Confirm delete connection")
    && connectionLifecycleDriverSource.includes("connection-provider-scan-receipt")
    && connectionLifecycleDriverSource.includes("binarySha256")
    && connectionLifecycleDriverSource.includes("baselineUi")
    && connectionLifecycleDriverSource.includes("waitForReleaseSurfaceInstalledInputElement")
    && !connectionLifecycleDriverSource.includes("acceptReleaseSurfaceInstalledInputAlert")
    && !connectionLifecycleDriverSource.includes("executeReleaseSurfaceInstalledInputScript")
    && navigationTabsDriverSource.includes("clickReleaseSurfaceInstalledInputElement")
    && navigationTabsDriverSource.includes("waitForSettingsTab")
    && navigationTabsDriverSource.includes("waitForRightRailTab")
    && !navigationTabsDriverSource.includes("executeReleaseSurfaceInstalledInputScript")
    && !navigationTabsDriverSource.includes("window.__TAURI_INTERNALS__")
    && tasksPanelLifecycleDriverSource.includes('relay.invoke("pty_create"')
    && tasksPanelLifecycleDriverSource.includes("waitForTaskStatus(relay, taskId, \"stopped\"")
    && tasksPanelLifecycleDriverSource.includes('relay.invoke("pty_kill"')
    && tasksPanelLifecycleDriverSource.includes("assertBaselineTasksPreserved")
    && !tasksPanelLifecycleDriverSource.includes("navigator.clipboard")
    && !tasksPanelLifecycleDriverSource.includes('relay.invoke("task_kill"')
    && !tasksPanelLifecycleDriverSource.includes("cleanup_mcp_clients")
    && !tasksPanelLifecycleDriverSource.includes("sendPrompt")
    && chatOutputLifecycleDriverSource.includes('debugRendererFixture: { id: "chat-output-lifecycle" }')
    && chatOutputLifecycleDriverSource.includes("performReleaseSurfaceInstalledInputKeyChord")
    && chatOutputLifecycleDriverSource.includes('debugRendererFixture: { id: "chat-output-lifecycle", action: "clear" }')
    && !chatOutputLifecycleDriverSource.includes("executeReleaseSurfaceInstalledInputScript")
    && !chatOutputLifecycleDriverSource.includes("navigator.clipboard")
    && chatOutputLifecycleDriverSource.includes("prepareOwnedPreviewFiles(request)")
    && chatOutputLifecycleDriverSource.includes("writeFileSync")
    && chatOutputLifecycleDriverSource.includes("rmSync")
    && chatOutputLifecycleDriverSource.includes("waitForObservedTitle")
    && !chatOutputLifecycleDriverSource.includes("onPreviewFile")
    && !chatOutputLifecycleDriverSource.includes("sendPrompt")
    && chatOutputJumpDebugDriverSource.includes('invocationTransport: "native-installed-input"')
    && chatOutputJumpDebugDriverSource.includes("exerciseChatOutputJumpDebugSurface")
    && !groupingSource.includes("VendorGroup")
    && !groupingSource.includes('kind: "vendor"')
    && groupingSource.includes('if (method && method.startsWith("_x.ai/"))')
    && localDisclosuresDriverSource.includes("clickReleaseSurfaceInstalledInputElement")
    && localDisclosuresDriverSource.includes("waitForReleaseSurfaceInstalledInputElementAbsent")
    && !localDisclosuresDriverSource.includes("executeReleaseSurfaceInstalledInputScript")
    && !localDisclosuresDriverSource.includes("window.__TAURI_INTERNALS__")
    && agentCliSetupLifecycleDriverSource.includes("clickReleaseSurfaceInstalledInputElement")
    && agentCliSetupLifecycleDriverSource.includes("clickReleaseSurfaceInstalledInputElementAtFraction")
    && agentCliSetupLifecycleDriverSource.includes('agentCliSetupFixture: "closed"')
    && !agentCliSetupLifecycleDriverSource.includes("executeReleaseSurfaceInstalledInputScript")
    && !agentCliSetupLifecycleDriverSource.includes("window.__TAURI_INTERNALS__")
    && vaultOwnedEditDriverSource.includes("readVaultDirectory(connection)")
    && activityBrowserLifecycleDriverSource.includes("prepareActivityFixture(request)")
    && activityBrowserLifecycleDriverSource.includes("performReleaseSurfaceInstalledInputKeyChord")
    && activityBrowserLifecycleDriverSource.includes("waitForExactPreview(connection, fixture.filePath, ownedTabId)")
    && activityBrowserLifecycleDriverSource.includes("cleanupActivityFixture(fixture)")
    && !activityBrowserLifecycleDriverSource.includes("executeReleaseSurfaceInstalledInputScript")
    && !activityBrowserLifecycleDriverSource.includes("window.__TAURI_INTERNALS__")
    && shellxagentLifecycleDriverSource.includes("clickReleaseSurfaceInstalledInputElement")
    && shellxagentLifecycleDriverSource.includes("observeReleaseSurfaceInstalledInputElement")
    && shellxagentLifecycleDriverSource.includes('debugShellxagentFixture: "clear"')
    && !shellxagentLifecycleDriverSource.includes("executeReleaseSurfaceInstalledInputScript")
    && !shellxagentLifecycleDriverSource.includes("navigator.clipboard")
    && !shellxagentLifecycleDriverSource.includes("shellxagent_token_regenerate")
    && shellxagentLifecycleDriverSource.includes("waitForRotatedToken")
    && shellxagentLifecycleDriverSource.includes("writeFileSync(tokenPath, original")
    && remoteCwdLifecycleDriverSource.includes("mkdtempSync")
    && remoteCwdLifecycleDriverSource.includes('isolated: action !== "use"')
    && remoteCwdLifecycleDriverSource.includes("activeTab: baseline.activeTab")
    && remoteCwdLifecycleDriverSource.includes("clickReleaseSurfaceInstalledInputElement")
    && remoteCwdLifecycleDriverSource.includes("setReleaseSurfaceInstalledInputElementValue")
    && remoteCwdLifecycleDriverSource.includes("waitForReleaseSurfaceInstalledInputElementAbsent")
    && !remoteCwdLifecycleDriverSource.includes("executeReleaseSurfaceInstalledInputScript")
    && !remoteCwdLifecycleDriverSource.includes("navigator.clipboard")
    && vaultOwnedEditDriverSource.includes("cleanupOwnedResources(connection, directoryBaseline!)")
    && vaultOwnedEditDriverSource.includes("await revealOwnedSecret(webdriver)")
    && !vaultOwnedEditDriverSource.includes("observeReleaseSurfaceInstalledInputElement(webdriver, REVEALED")
    && !vaultOwnedEditDriverSource.includes("window.__TAURI_INTERNALS__")
    && vaultTabSource.includes('data-debug-id="vault-row-reveal" data-shellx-sensitive="true"')
    && vaultTabSource.includes('data-shellx-sensitive="true"')
    && vaultTabSource.match(/data-shellx-release-observe="value"/g)?.length === 4
    && vaultTabSource.match(/data-shellx-release-observe="checked"/g)?.length === 4
    && vaultTabSource.match(/data-shellx-release-observe="disabled"/g)?.length === 1,
  "main-window bottom and navigation tabs, reversible Session Tabs, owned TasksPanel, and text-only owned ChatOutput lifecycles, local disclosures, owned-dialog/input/theme/project/Open chats/Past chats/File Preview/Agent Runs Refresh, safe unsaved and owned Vault edits, Connectors drafts, per-tab ShellX tool exposure, Browser Shields and profile ad modes, Work Preview lifecycle/kind/viewport/refresh/doctor/center, and Flight Recorder controls must use bounded installed-input events on supported platforms and restore every fixture",
);
assert(
  readFileSync(resolve(root, "src", "components", "CommandPalette.tsx"), "utf8")
    .includes('data-palette-action-id={r.group === "Action" ? r.id : undefined}'),
  "installed palette driver requires stable action-id selectors instead of label matching",
);
assert.equal(contract.candidateStage, "signed-and-frozen");
assert.equal(contract.executionWindow, "immediately-before-publish");
assert.equal(contract.routineTestUsage, "forbidden");
assert.deepEqual(
  [...contract.invalidatedBy].sort(),
  ["artifact-change", "inventory-change", "signature-change", "source-change"],
  "every candidate identity change must invalidate the final receipts",
);
const fixtureInventory: ReleaseSurfaceInventory = {
  schema: RELEASE_SURFACE_INVENTORY_SCHEMA,
  platforms: [...RELEASE_PLATFORMS],
  digest: "a".repeat(64),
  counts: {
    "tauri-command": 1,
    "debug-api-route": 0,
    "host-mcp-tool": 0,
    "browser-cli-command": 0,
    "palette-action": 0,
    "keyboard-shortcut": 0,
    "shellx-command": 0,
    "ui-debug-surface": 0,
    "ui-control": 0,
  },
  unresolvedInteractiveControls: 0,
  copyDerivedInteractiveControls: 0,
  uiDriverFamilyAccounting: {
    selection: 0,
    disclosure: 0,
    toggle: 0,
    "text-entry": 0,
    choice: 0,
    range: 0,
    "file-picker": 0,
    activation: 0,
    "static-marker": 0,
    "dynamic-marker": 0,
  },
  occurrenceAccounting: {
    uiControls: { candidates: 0, excludedNonActions: 0, finiteVariantInstances: 0, inventoried: 0 },
    uiDebugSurfaces: { candidates: 0, finiteVariantInstances: 0, inventoried: 0 },
  },
  items: [{
    id: "tauri-command:fixture",
    kind: "tauri-command",
    name: "fixture",
    source: "fixture.rs",
    platforms: [...RELEASE_PLATFORMS],
    delivery: "installed-app",
  }],
};
const fixtureDriverPlanValue: FinalSurfaceDriverPlan = {
  schema: FINAL_SURFACE_DRIVER_PLAN_SCHEMA,
  mode: "final-frozen-candidate",
  inventoryDigest: fixtureInventory.digest,
  releaseReady: true,
  drivers: [{
    id: "fixture-installed",
    kind: "tauri-command",
    entrypoint: "scripts/release-drivers/fixture-installed.ts",
    platforms: {
      "windows-installed": "ready",
      "macos-installed": "ready",
      "linux-installed": "ready",
    },
  }],
  assignments: [{
    surfaceId: "tauri-command:fixture",
    driverId: "fixture-installed",
    fixtureId: "fixture:isolated-profile",
    expectedEffect: "fixture command returns its isolated result",
    oracleId: "fixture:isolated-result",
    cleanupId: "fixture:remove-isolated-profile",
  }],
};
const receipts = RELEASE_PLATFORMS.map((platform) => fixtureReceipt(platform));
const verifiedEvidenceArtifacts = Object.fromEntries(
  RELEASE_PLATFORMS.map((platform) => [platform, [`fixture-${platform}`]]),
);
const pass = verifyFinalSurfaceReceipts({
  contract,
  inventory: fixtureInventory,
  driverPlan: fixtureDriverPlan(),
  receipts,
  sourceCommit: "b".repeat(40),
  version: "0.3.5",
  verifiedEvidenceArtifacts,
});
assert.equal(pass.status, "pass", JSON.stringify(pass.findings, null, 2));
assert.equal(pass.counts.verifiedOutcomes, 3);

const fixtureDriverVerification = verifyFinalSurfaceDriverPlan(fixtureDriverPlanValue, fixtureInventory);
assert.equal(fixtureDriverVerification.status, "ready", JSON.stringify(fixtureDriverVerification.findings, null, 2));
assert.equal(fixtureDriverVerification.counts.ready, 3);

const platformBuildingPlan = structuredClone(fixtureDriverPlanValue);
platformBuildingPlan.releaseReady = false;
platformBuildingPlan.drivers[0]!.platforms["macos-installed"] = "building";
const platformBuilding = verifyFinalSurfaceDriverPlan(platformBuildingPlan, fixtureInventory);
assert.equal(platformBuilding.status, "building", JSON.stringify(platformBuilding.findings, null, 2));
assert.equal(platformBuilding.counts.assigned, 3, "one assignment covers all three shipped platform cells");
assert.equal(platformBuilding.counts.ready, 2, "Windows and Linux readiness must not imply macOS readiness");
assert.equal(platformBuilding.counts.missing, 0, "a building platform lane is assigned but not ready");
assert.deepEqual(platformBuilding.counts.readyByPlatform, {
  "windows-installed": 1,
  "macos-installed": 0,
  "linux-installed": 1,
});

const missingMacLanePlan = structuredClone(fixtureDriverPlanValue);
missingMacLanePlan.releaseReady = false;
delete missingMacLanePlan.drivers[0]!.platforms["macos-installed"];
const missingMacLane = verifyFinalSurfaceDriverPlan(missingMacLanePlan, fixtureInventory);
assert.equal(missingMacLane.status, "building", JSON.stringify(missingMacLane.findings, null, 2));
assert.equal(missingMacLane.counts.assigned, 2);
assert.equal(missingMacLane.counts.missing, 1, "an undeclared platform lane remains an explicit missing cell");

const brokenReceipt = structuredClone(receipts[0]!);
brokenReceipt.outcomes = [];
const fail = verifyFinalSurfaceReceipts({
  contract,
  inventory: fixtureInventory,
  driverPlan: fixtureDriverPlan(),
  receipts: [brokenReceipt, ...receipts.slice(1)],
  sourceCommit: "b".repeat(40),
  version: "0.3.5",
  verifiedEvidenceArtifacts,
});
assert.equal(fail.status, "fail");
assert(fail.findings.some((finding) => finding.ruleId === "outcome-missing"));

const unstableInventory = { ...fixtureInventory, unresolvedInteractiveControls: 1 };
const unstable = verifyFinalSurfaceReceipts({
  contract,
  inventory: unstableInventory,
  driverPlan: fixtureDriverPlan(),
  receipts,
  sourceCommit: "b".repeat(40),
  version: "0.3.5",
  verifiedEvidenceArtifacts,
});
assert(unstable.findings.some((finding) => finding.ruleId === "unstable-ui-selectors"));

const badReferenceReceipt = structuredClone(receipts[0]!);
badReferenceReceipt.outcomes[0]!.evidence = "undeclared-evidence";
const badReference = verifyFinalSurfaceReceipts({
  contract,
  inventory: fixtureInventory,
  driverPlan: fixtureDriverPlan(),
  receipts: [badReferenceReceipt, ...receipts.slice(1)],
  sourceCommit: "b".repeat(40),
  version: "0.3.5",
  verifiedEvidenceArtifacts,
});
assert(badReference.findings.some((finding) => finding.ruleId === "evidence-reference"));

const missingProviderRouteReceipt = structuredClone(receipts[0]!);
missingProviderRouteReceipt.providerRoutes.pop();
const missingProviderRoute = verifyFinalSurfaceReceipts({
  contract,
  inventory: fixtureInventory,
  driverPlan: fixtureDriverPlan(),
  receipts: [missingProviderRouteReceipt, ...receipts.slice(1)],
  sourceCommit: "b".repeat(40),
  version: "0.3.5",
  verifiedEvidenceArtifacts,
});
assert(missingProviderRoute.findings.some((finding) => finding.ruleId === "provider-route-missing"));

const evidenceRoot = mkdtempSync(join(tmpdir(), "shellx-release-surface-evidence-"));
try {
  const evidenceReceipt = fixtureReceipt("windows-installed");
  const evidenceBytes = Buffer.from('{"surface":"fixture","status":"pass"}\n', "utf8");
  const evidencePath = join(evidenceRoot, "windows", "surface-evidence.jsonl");
  mkdirSync(join(evidenceRoot, "windows"), { recursive: true });
  writeFileSync(evidencePath, evidenceBytes);
  evidenceReceipt.evidenceArtifacts[0] = {
    id: "fixture-windows-installed",
    relativePath: "windows/surface-evidence.jsonl",
    sha256: createHash("sha256").update(evidenceBytes).digest("hex"),
    bytes: evidenceBytes.length,
  };
  const evidencePass = verifyReleaseSurfaceEvidenceFiles(evidenceRoot, [evidenceReceipt]);
  assert.deepEqual(evidencePass.errors, []);
  assert.deepEqual(evidencePass.verified["windows-installed"], ["fixture-windows-installed"]);

  const wrongHash = structuredClone(evidenceReceipt);
  wrongHash.evidenceArtifacts[0]!.sha256 = "0".repeat(64);
  assert(
    verifyReleaseSurfaceEvidenceFiles(evidenceRoot, [wrongHash]).errors.some((error) => error.includes("sha256 mismatch")),
    "final evidence verification must reject changed bytes",
  );

  const traversal = structuredClone(evidenceReceipt);
  traversal.evidenceArtifacts[0]!.relativePath = "../outside.json";
  assert(
    verifyReleaseSurfaceEvidenceFiles(evidenceRoot, [traversal]).errors.some((error) => error.includes("escapes receipts directory")),
    "final evidence verification must reject paths outside private receipt storage",
  );
} finally {
  rmSync(evidenceRoot, { recursive: true });
}

console.log(
  `Release surface inventory contracts passed: ${generated.items.length} shipped surfaces, `
  + `${generated.unresolvedInteractiveControls} unresolved UI selectors`,
);

function fixtureReceipt(platform: ReleasePlatform): FinalSurfaceReceipt {
  const platformContract = contract.platforms[platform];
  const evidenceId = `fixture-${platform}`;
  return {
    schema: FINAL_SURFACE_RECEIPT_SCHEMA,
    mode: "final-frozen-candidate",
    platform,
    sourceCommit: "b".repeat(40),
    version: "0.3.5",
    inventoryDigest: fixtureInventory.digest,
    startedAt: "2026-07-28T18:00:00.000Z",
    completedAt: "2026-07-28T19:00:00.000Z",
    artifact: {
      basename: `shellx-${platform}`,
      sha256: "c".repeat(64),
      signatureStatus: platformContract.signatureStatus,
    },
    evidenceArtifacts: [{
      id: evidenceId,
      relativePath: `${platform}/surface-evidence.jsonl`,
      sha256: "d".repeat(64),
      bytes: 128,
    }],
    transports: platformContract.requiredTransports.map((id) => ({ id, status: "pass", evidence: evidenceId })),
    providers: contract.requiredProviders.map((id) => ({ id, status: "pass", version: "fixture", evidence: evidenceId })),
    providerRoutes: platformContract.requiredProviderRoutes.map(({ providerId, transportId }) => ({
      id: `${providerId}::${transportId}`,
      providerId,
      transportId,
      status: "pass" as const,
      evidenceMode: platformContract.requiredLiveProviderRoutes.some(
        (route) => route.providerId === providerId && route.transportId === transportId,
      ) ? "live-canary" as const : "identity-only" as const,
      version: "fixture",
      executableSha256: "e".repeat(64),
      evidence: evidenceId,
    })),
    health: { startup: "pass", shutdown: "pass", brokenLinks: 0, unexpectedConsoleErrors: 0, evidence: evidenceId },
    outcomes: [{
      id: "tauri-command:fixture",
      expectedEffect: "fixture command returns its isolated result",
      oracleId: "fixture:isolated-result",
      present: "pass",
      invoke: "pass",
      effect: "pass",
      cleanup: "pass",
      evidence: evidenceId,
      cleanupEvidence: evidenceId,
      observedEffect: "fixture command returned its intended isolated result",
    }],
  };
}

function fixtureDriverPlan(): FinalSurfaceDriverPlan {
  return structuredClone(fixtureDriverPlanValue);
}
