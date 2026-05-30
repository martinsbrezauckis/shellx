import {
  normalizePreviewReference,
  previewPathHasParentTraversal,
  resolvePreviewPath,
  resolvePreviewRoute,
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
  resolvePreviewPath("./notes.md", "C:\\Users\\User\\Documents\\New project 3") ===
    "C:\\Users\\User\\Documents\\New project 3\\notes.md",
  "relative file paths resolve against Windows session cwd",
);
assert(
  resolvePreviewPath("src/App.tsx", "/home/user/app") === "/home/user/app/src/App.tsx",
  "relative file paths resolve against POSIX session cwd",
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
