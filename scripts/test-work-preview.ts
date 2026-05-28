import {
  clearWorkPreviewBrowserEvents,
  emptyWorkPreviewState,
  getWorkPreviewBrowserEvents,
  isStaticHtmlPreviewPath,
  recordWorkPreviewBrowserEvent,
  workPreviewActionHint,
  workPreviewEntryForFilePath,
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
  level: "error",
  message: "ReferenceError: missingState is not defined",
  source: "index.html",
});
assert(getWorkPreviewBrowserEvents("preview-tab").length === 1, "browser events are retained for Preview Doctor");
clearWorkPreviewBrowserEvents("preview-tab");
assert(getWorkPreviewBrowserEvents("preview-tab").length === 0, "browser events can be cleared per tab");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} work preview helper tests`);
process.exit(failures === 0 ? 0 : 1);
