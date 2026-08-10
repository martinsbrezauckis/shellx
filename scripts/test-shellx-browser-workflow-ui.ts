import { readFileSync } from "node:fs";

import {
  browserWorkflowBadgeLabel,
  browserWorkflowNeedsRefresh,
} from "../src/browser/browserWorkflowPresentation";
import { browserEngineSyncBoundsForRect } from "../src/browser/browserEngineLayout";
import { parseBrowserWorkflowPreview } from "../src/browser/browserWorkflowPreview";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}

console.log("\n=== ShellX Browser saved workflow UI ===");

const workflow = {
  lastImprovementRating: "safety-regression",
  lastImprovementScore: -25,
  refreshReason: "The page contract changed",
  refreshCandidateRecipePath: "/private/never-render-this.json",
};

assert(
  browserWorkflowBadgeLabel(workflow) === "safety regression -25",
  "labels fail-closed evaluation outcomes without exposing artifact metadata",
);
assert(browserWorkflowNeedsRefresh(workflow), "marks a bounded refresh proposal as needing attention");
assert(!browserWorkflowNeedsRefresh({ health: "fresh" }), "does not invent refresh work for a healthy workflow");

const visibleEngineBounds = browserEngineSyncBoundsForRect({ left: 12, top: 48, width: 900, height: 640 });
assert(
  visibleEngineBounds.x === 12 && visibleEngineBounds.y === 48
    && visibleEngineBounds.width === 900 && visibleEngineBounds.height === 640,
  "keeps visible native engine bounds aligned to the renderer slot",
);
const parkedEngineBounds = browserEngineSyncBoundsForRect({ left: 0, top: 0, width: 600, height: 0 });
assert(
  parkedEngineBounds.x === -30_000 && parkedEngineBounds.y === -30_000
    && parkedEngineBounds.width === 1_024 && parkedEngineBounds.height === 768,
  "parks the native engine when a responsive sidecar collapses its renderer slot",
);

const preview = parseBrowserWorkflowPreview("workflow-1", {
  ok: true,
  dryRun: true,
  stepsPlanned: 4,
  stepsSkipped: 2,
  decisionPoints: [{}, {}],
});
assert(preview.status === "ready" && preview.stepsPlanned === 4, "accepts a dry-run replay summary");
assert(preview.stepsSkipped === 2 && preview.decisionPoints === 2, "keeps only bounded preview counts");

let rejectedAppliedReplay = false;
try {
  parseBrowserWorkflowPreview("workflow-1", { ok: true, dryRun: false, stepsPlanned: 4 });
} catch {
  rejectedAppliedReplay = true;
}
assert(rejectedAppliedReplay, "rejects a replay response that was not dry-run");

const sidecar = readFileSync(new URL("../src/browser/components/BookmarkSidecar.tsx", import.meta.url), "utf8");
const hook = readFileSync(new URL("../src/browser/hooks/useBrowserBookmarks.ts", import.meta.url), "utf8");
const backend = readFileSync(new URL("../src-tauri/src/shellx_browser_bookmarks.rs", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/browser/browserWorkflows.css", import.meta.url), "utf8");
const browserApp = readFileSync(new URL("../src/components/ShellxBrowserApp.tsx", import.meta.url), "utf8");
const agentSidebar = readFileSync(new URL("../src/browser/components/AgentSidebar.tsx", import.meta.url), "utf8");
const nativeEngineSync = readFileSync(new URL("../src/browser/hooks/useNativeEngineSync.ts", import.meta.url), "utf8");
const browserTasks = readFileSync(new URL("../src/browser/hooks/useBrowserTasks.ts", import.meta.url), "utf8");
const sidebarResize = readFileSync(new URL("../src/browser/hooks/useBrowserSidebarResize.ts", import.meta.url), "utf8");
const browserShellCss = readFileSync(new URL("../src/browser/browserShell.css", import.meta.url), "utf8");
const browserLayoutCss = readFileSync(new URL("../src/browser/browserLayout.css", import.meta.url), "utf8");

assert(sidecar.includes("browserWorkflowBadgeLabel") && sidecar.includes("Refresh suggested"), "renders compact workflow health and refresh badges");
assert(sidecar.includes('data-debug-id="shellx-browser-workflow-preview"'), "renders a dedicated preview result surface");
assert(sidecar.includes("live recovery") && sidecar.includes("decisions"), "explains planned, skipped, and decision counts separately");
assert(!sidecar.includes("{workflow.refreshReason}") && !sidecar.includes("{workflow.refreshCandidateRecipePath}"), "does not render raw refresh reasons or private recipe paths");
assert(hook.includes('browserApiPostJson<unknown>("/browser/recipes/replay"'), "uses the existing guarded recipe replay route");
assert(hook.includes("dryRun: true") && !hook.includes("apply: true"), "workflow clicks always request preview mode and never silent apply");
assert(
  hook.includes('status: "error"') && !hook.includes("throw cause"),
  "contains handled preview failures in the dedicated workflow status surface",
);
assert(backend.includes('"safety-regression"') && backend.includes('"incomplete-evaluation"'), "bookmark normalization preserves current fail-closed ratings");
assert(css.includes(".shellx-browser-bookmark-workflow-badge") && css.includes(".shellx-browser-workflow-preview"), "styles status and preview surfaces");
assert(
  sidecar.includes('workflowPreview ? "has-workflow-preview" : ""')
    && css.includes(".shellx-browser-bookmark-sidecar.has-workflow-preview")
    && css.includes("grid-template-rows: auto auto minmax(0, 1fr);"),
  "keeps workflow preview compact without displacing the bookmark list",
);
assert(
  css.includes("color: var(--shellx-browser-workflow-warn-ink);")
    && css.includes("border-left: 3px solid var(--shellx-browser-ref-ink);")
    && css.includes("border-left-color: var(--err);")
    && !css.includes("color: #fbbf24;")
    && !css.includes("rgba(59, 130, 246"),
  "uses Browser semantic tokens for workflow warning, information, and error states",
);
const lightBrowserSurface = cssHexToken(
  cssSelectorBlock(browserLayoutCss, '.shellx-browser-app[data-color-mode="light"]'),
  "--surface-2",
);
const darkBrowserSurface = cssHexToken(
  cssSelectorBlock(browserLayoutCss, '.shellx-browser-app[data-color-mode="dark"]'),
  "--surface-2",
);
const workflowRootTokens = cssSelectorBlock(browserShellCss, ".shellx-browser-app");
const workflowLightTokens = cssSelectorBlock(browserShellCss, '.shellx-browser-app[data-color-mode="light"]');
const workflowWarningContrast = [
  {
    label: "light",
    foreground: cssHexToken(workflowLightTokens, "--shellx-browser-workflow-warn-ink"),
    background: lightBrowserSurface,
  },
  {
    label: "dark",
    foreground: cssHexToken(workflowRootTokens, "--shellx-browser-workflow-warn-ink"),
    background: darkBrowserSurface,
  },
];
for (const { label, foreground, background } of workflowWarningContrast) {
  const ratio = contrastRatio(foreground, background);
  assert(ratio >= 4.5, `${label} workflow warning contrast ${ratio.toFixed(2)} meets WCAG AA`);
}
assert(
  browserApp.includes('"--shellx-browser-right-sidebar-width"') && !browserApp.includes("gridTemplateColumns"),
  "keeps runtime widths in CSS variables so responsive rules can stack the Browser layout",
);
assert(
  browserShellCss.includes(".shellx-browser-grid.with-left-sidecar")
    && browserShellCss.includes(".shellx-browser-grid.with-left-sidecar.hide-right")
    && browserShellCss.includes("grid-template-columns: minmax(0, 1fr);")
    && browserShellCss.includes("grid-template-rows: minmax(0, 220px) minmax(320px, 1fr) minmax(0, 220px);")
    && browserShellCss.includes("grid-template-rows: minmax(0, 220px) minmax(320px, 1fr);"),
  "defines explicit responsive content, sidecar, and agent-panel rows",
);
assert(
  agentSidebar.includes("onResizeKeyDown")
    && browserApp.includes("useBrowserSidebarResize")
    && sidebarResize.includes('event.key === "ArrowLeft"')
    && sidebarResize.includes('event.key === "ArrowRight"')
    && sidebarResize.includes("cleanupRef.current"),
  "supports keyboard resizing while retaining the pointer resize path",
);
assert(
  nativeEngineSync.includes("browserEngineSyncBoundsForRect")
    && nativeEngineSync.includes("bounds,"),
  "routes every native engine resize through visible-or-parked bounds normalization",
);
assert(
  browserShellCss.includes("grid-template-columns: repeat(4, 32px) minmax(0, 1fr);")
    && browserShellCss.includes("grid-column: 1 / -1;")
    && browserShellCss.includes("flex-wrap: wrap;"),
  "stacks toolbar actions instead of horizontally panning narrow Browser windows",
);
assert(
  browserShellCss.includes('.shellx-browser-app[data-color-mode="light"]')
    && browserShellCss.includes("--shellx-browser-viewport-card:")
    && browserShellCss.includes(".shellx-browser-viewport-inner h2")
    && browserShellCss.includes("color: var(--ink);")
    && browserShellCss.includes("color: var(--ink-2);"),
  "keeps the native engine placeholder readable in light and dark modes",
);
assert(
  cssSelectorBlock(browserShellCss, '.shellx-browser-app[data-color-mode="light"]').includes("color-scheme: light;")
    && cssSelectorBlock(browserShellCss, '.shellx-browser-app[data-color-mode="dark"]').includes("color-scheme: dark;")
    && browserShellCss.includes('@media (prefers-color-scheme: light) {\n  .shellx-browser-app[data-color-mode="system"] {\n    color-scheme: light;')
    && browserShellCss.includes('@media (prefers-color-scheme: dark) {\n  .shellx-browser-app[data-color-mode="system"] {\n    color-scheme: dark;'),
  "keeps native Browser form controls aligned with explicit and system color modes",
);
assert(
  browserTasks.includes("runTaskControl")
    && agentSidebar.includes("taskControlBusy")
    && agentSidebar.includes('activeTask.status === "aborted" || taskControlBusy'),
  "keeps pause, takeover, and abort controls independent from unrelated Browser work",
);
assert(
  !agentSidebar.includes("onClick={() => undefined}")
    && agentSidebar.includes('className="shellx-browser-section-heading static"'),
  "does not expose inert transfer controls",
);
assert(
  agentSidebar.includes("aria-current={task.taskId === activeTask?.taskId")
    && !agentSidebar.includes("<button\n              key={task.taskId}"),
  "renders task history as truthful status rows rather than inert buttons",
);

console.log("ShellX Browser saved workflow UI checks passed");

function cssHexToken(source: string, name: string): string {
  const match = source.match(new RegExp(`${name.replace("-", "\\-")}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) throw new Error(`missing hex token ${name}`);
  return match[1];
}

function cssSelectorBlock(source: string, selector: string): string {
  const marker = `${selector} {`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing CSS selector: ${selector}`);
  const bodyStart = start + marker.length;
  const bodyEnd = source.indexOf("}", bodyStart);
  if (bodyEnd < 0) throw new Error(`unterminated CSS selector: ${selector}`);
  return source.slice(bodyStart, bodyEnd);
}

function contrastRatio(left: string, right: string): number {
  const [lighter, darker] = [relativeLuminance(left), relativeLuminance(right)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}
