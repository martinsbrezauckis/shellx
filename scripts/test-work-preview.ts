import { readFileSync } from "node:fs";

import {
  clearWorkPreviewBrowserEvents,
  emptyWorkPreviewState,
  getWorkPreviewBrowserEvents,
  isStaticHtmlPreviewPath,
  recordWorkPreviewBrowserEvent,
  workPreviewActionHint,
  workPreviewEntryForFilePath,
  workPreviewDefaultViewport,
  workPreviewKindLabel,
  workPreviewRootForFilePath,
  workPreviewStatusLabel,
} from "../src/lib/work-preview";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== work preview helpers ===");

const empty = emptyWorkPreviewState("preview-tab");
assert(empty.tabId === "preview-tab", "empty state keeps tab id");
assert(empty.status === "idle", "empty state starts idle");
assert(empty.url === null, "empty state has no URL");
assert(workPreviewStatusLabel("running") === "running", "running status label is stable");
assert(workPreviewKindLabel("staticHtml") === "Static HTML", "static label is user-facing");
assert(workPreviewKindLabel("webApp") === "Web app", "web app label is user-facing");
assert(workPreviewKindLabel("expoWeb") === "Expo web", "expo label is user-facing");
assert(workPreviewDefaultViewport({ ...empty, kind: "expoWeb" }) === "phone", "Expo web previews default to phone");
assert(
  workPreviewDefaultViewport({ ...empty, kind: "staticHtml", viewportHint: "phone" }) === "phone",
  "Expo static exports can request phone preview",
);
assert(workPreviewDefaultViewport({ ...empty, kind: "staticHtml" }) === "desktop", "ordinary static previews default to desktop");
assert(
  workPreviewActionHint({
    kind: "expoWeb",
    error: null,
    logs: [{ t: Date.now(), stream: "stderr", line: "Install react-dom@19.2.3, react-native-web@^0.21.2 by running:" }],
  })?.includes("npx expo install react-dom react-native-web") ?? false,
  "Expo web missing dependency hint is actionable",
);
assert(
  workPreviewActionHint({
    kind: "webApp",
    error: null,
    logs: [{ t: Date.now(), stream: "stderr", line: "react-native-web appears in unrelated docs" }],
  }) === null,
  "Expo dependency hint does not appear for generic web apps",
);
assert(isStaticHtmlPreviewPath("C:/Users/User/Documents/New project 3/shellx-preview-test.html"), "html path is static-previewable");
assert(!isStaticHtmlPreviewPath("C:/Users/User/Documents/New project 3/app.js"), "non-html path is not static-previewable");
assert(
  workPreviewRootForFilePath("C:/Users/User/Documents/New project 3/shellx-preview-test.html") ===
    "C:/Users/User/Documents/New project 3",
  "Windows preview root comes from HTML parent folder",
);
assert(
  workPreviewEntryForFilePath("C:/Users/User/Documents/New project 3/shellx-preview-test.html") ===
    "shellx-preview-test.html",
  "Windows preview entry comes from HTML filename",
);
clearWorkPreviewBrowserEvents("preview-tab");
recordWorkPreviewBrowserEvent("preview-tab", {
  t: 1000,
  level: "error",
  message: "ReferenceError: missingState is not defined",
  source: "index.html",
  url: "http://127.0.0.1:5000/index.html?__shellx_preview=1",
});
assert(getWorkPreviewBrowserEvents("preview-tab").length === 1, "browser events are retained for Preview Doctor");
assert(
  getWorkPreviewBrowserEvents("preview-tab", { url: "http://127.0.0.1:5000/index.html", sinceMs: 999 }).length === 1,
  "browser events are kept for the current preview origin and generation",
);
assert(
  getWorkPreviewBrowserEvents("preview-tab", { url: "http://127.0.0.1:5001/index.html", sinceMs: 999 }).length === 0,
  "browser events from old preview origins are ignored",
);
assert(
  getWorkPreviewBrowserEvents("preview-tab", { url: "http://127.0.0.1:5000/index.html", sinceMs: 2000 }).length === 0,
  "browser events from old preview generations are ignored",
);
clearWorkPreviewBrowserEvents("preview-tab");
assert(getWorkPreviewBrowserEvents("preview-tab").length === 0, "browser events can be cleared per tab");

const appSource = readFileSync("src/App.tsx", "utf8");
const rightRailSource = readFileSync("src/components/RightRail.tsx", "utf8");
const panelSource = readFileSync("src/components/WorkPreviewPanel.tsx", "utf8");
assert(
  appSource.includes("poll: refreshWorkPreviews") &&
    appSource.includes("intervalMs: anyRunningPreview ? 2_000 : 5_000") &&
    appSource.includes("workPreviewPollingVisible") &&
    !appSource.includes("[workPreviewTabIdsKey, workPreviewByTab]"),
  "App owns one serialized, visibility-aware Work Preview polling loop",
);
assert(
  appSource.includes("workPreviewState={rightRailWorkPreviewState}") &&
    rightRailSource.includes("stateSnapshot={workPreviewState}"),
  "App state feeds the visible Work Preview panel without a second backend poll",
);
assert(
  !panelSource.includes("window.setInterval(() => void refresh(), running ? 1500 : 4000)") &&
    panelSource.includes("stateSnapshot?.tabId === tabId"),
  "Work Preview panel keeps manual refresh while consuming the shared live snapshot",
);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} work preview helper tests`);
process.exit(failures === 0 ? 0 : 1);
