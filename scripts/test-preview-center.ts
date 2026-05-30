import {
  normalizePreviewReference,
  previewPathHasParentTraversal,
  resolvePreviewPath,
  resolvePreviewRoute,
  resolveSessionMarkdownArtifactPath,
} from "../src/lib/preview-center";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== preview center routing ===");

assert(
  normalizePreviewReference("/C:/Users/User/Documents/New%20project%203/page.html") ===
    "C:/Users/User/Documents/New project 3/page.html",
  "encoded /C:/ paths normalize to Windows absolute paths",
);
assert(
  normalizePreviewReference(
    "C:\\Users\\User\\.grok\\sessions\\C%3A%5CUsers%5CUser%5CDownloads%5CShellX%20improvements\\019e7ace\\images\\1.jpg",
  ) ===
    "C:\\Users\\User\\.grok\\sessions\\C%3A%5CUsers%5CUser%5CDownloads%5CShellX%20improvements\\019e7ace\\images\\1.jpg",
  "encoded Grok session paths stay byte-identical so generated images still exist on disk",
);
assert(
  normalizePreviewReference(
    "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject/019abc/images/1.jpg",
  ) ===
    "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject/019abc/images/1.jpg",
  "encoded WSL Grok session paths are not decoded into a different folder",
);
assert(
  resolvePreviewPath("./notes.md", "C:\\Users\\User\\Documents\\New project 3") ===
    "C:\\Users\\User\\Documents\\New project 3\\notes.md",
  "relative file paths resolve against Windows session cwd",
);
assert(
  resolvePreviewPath("src/App.tsx", "/home/user/app") === "/home/user/app/src/App.tsx",
  "relative file paths resolve against POSIX session cwd",
);
assert(
  resolveSessionMarkdownArtifactPath("plan.md", {
    cwd: "C:\\Users\\User",
    sessionId: "019e7aab-e6c4-7cd3-8dbf-be10b70f2737",
  }) ===
    "C:\\Users\\User\\.grok\\sessions\\C%3A%5CUsers%5CUser\\019e7aab-e6c4-7cd3-8dbf-be10b70f2737\\plan.md",
  "bare plan.md chat links resolve to the active Windows Grok session artifact",
);
assert(
  resolveSessionMarkdownArtifactPath("goal.md", {
    cwd: "/home/user/app",
    sessionId: "019abc",
  }) === "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fapp/019abc/goal.md",
  "bare goal.md chat links resolve to the active POSIX Grok session artifact",
);
assert(
  resolveSessionMarkdownArtifactPath("src/App.tsx", {
    cwd: "C:\\Users\\User",
    sessionId: "019abc",
  }) === null,
  "normal relative files keep resolving against cwd",
);
assert(
  resolveSessionMarkdownArtifactPath("C:\\Users\\User\\plan.md", {
    cwd: "C:\\Users\\User",
    sessionId: "019abc",
  }) === null,
  "absolute markdown paths are not rewritten as session artifacts",
);
assert(previewPathHasParentTraversal("../secret.txt"), "parent traversal is blocked");
assert(!previewPathHasParentTraversal("C:\\Users\\User\\Documents\\page.html"), "normal Windows paths are allowed");

const htmlRoute = resolvePreviewRoute({
  path: "page.html",
  cwd: "C:\\Users\\User\\Documents\\New project 3",
  canRunWorkPreview: true,
});
assert(htmlRoute.ok && htmlRoute.view === "work", "HTML file links route to Work Preview when desktop host is available");
assert(
  htmlRoute.ok &&
    htmlRoute.workRoot === "C:\\Users\\User\\Documents\\New project 3" &&
    htmlRoute.workEntry === "page.html",
  "HTML Work Preview route includes root and entry file",
);

const markdownRoute = resolvePreviewRoute({
  path: "README.md",
  cwd: "/home/user/app",
  canRunWorkPreview: true,
});
assert(markdownRoute.ok && markdownRoute.view === "file", "markdown files stay in document preview");

const browserHtmlRoute = resolvePreviewRoute({
  path: "page.html",
  cwd: "/home/user/app",
  canRunWorkPreview: false,
});
assert(browserHtmlRoute.ok && browserHtmlRoute.view === "file", "HTML falls back to document preview without desktop Work Preview");

const blockedRoute = resolvePreviewRoute({
  path: "../secret.txt",
  cwd: "/home/user/app",
  canRunWorkPreview: true,
});
assert(!blockedRoute.ok && blockedRoute.reason.includes("unsafe path"), "unsafe relative paths return a blocked route");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} preview center tests`);
process.exit(failures === 0 ? 0 : 1);
