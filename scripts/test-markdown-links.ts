import {
  fileDisplayName,
  isPreviewableFileHref,
  linkifyPreviewableFileRefs,
  localHrefToPreviewPath,
  resolveMarkdownPreviewHref,
} from "../src/lib/markdown-links";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== markdown/file link normalization ===");
assert(
  resolveMarkdownPreviewHref("/home/user/docs/README.md", "./plan.md") === "/home/user/docs/plan.md",
  "relative markdown link resolves next to current markdown file",
);
assert(
  resolveMarkdownPreviewHref("/home/user/docs/guide/README.md", "../plan.md") === "/home/user/docs/plan.md",
  "relative markdown link normalizes parent segments",
);
assert(
  resolveMarkdownPreviewHref("C:\\Users\\User\\repo\\docs\\guide.md", "..\\src\\main.ts") === "C:\\Users\\User\\repo\\src\\main.ts",
  "Windows relative markdown link normalizes parent segments",
);
assert(
  resolveMarkdownPreviewHref(undefined, "/home/user/src/App.tsx:42") === "/home/user/src/App.tsx",
  "POSIX file link strips trailing line suffix",
);
assert(
  resolveMarkdownPreviewHref(undefined, "C:\\Users\\User\\shellX\\src\\App.tsx:42:7") === "C:\\Users\\User\\shellX\\src\\App.tsx",
  "Windows file link strips trailing line and column suffix",
);
assert(
  fileDisplayName("C:\\Users\\User\\shellX\\docs\\Goal Plan.md:12") === "Goal Plan.md",
  "display name ignores line suffix",
);
assert(
  isPreviewableFileHref("file:///C:/Users/User/shellX/docs/goal.md"),
  "file:// markdown links are previewable",
);
assert(
  localHrefToPreviewPath("/C:/Users/User/Documents/New%20project%203/shellx-preview-test.html") ===
    "C:/Users/User/Documents/New project 3/shellx-preview-test.html",
  "encoded /C:/ markdown links normalize to Windows paths",
);
assert(
  resolveMarkdownPreviewHref(undefined, "/C:/Users/User/Documents/New%20project%203/shellx-preview-test.html") ===
    "C:/Users/User/Documents/New project 3/shellx-preview-test.html",
  "encoded Windows HTML links resolve without fake POSIX prefix",
);
assert(
  fileDisplayName("/C:/Users/User/Documents/New%20project%203/shellx-preview-test.html") ===
    "shellx-preview-test.html",
  "display name decodes encoded Windows path links",
);
assert(
  isPreviewableFileHref("/C:/Users/User/Documents/New%20project%203/shellx-preview-test.html"),
  "encoded Windows HTML links are previewable",
);
const linkedBareHtml = linkifyPreviewableFileRefs("Open shellx-preview-test.html after the build.");
assert(
  linkedBareHtml.includes("[shellx-preview-test.html](shellx-preview-test.html)"),
  "bare HTML filenames become preview links",
);
const linkedWindowsHtml = linkifyPreviewableFileRefs("Open C:\\Users\\User\\Documents\\New project 3\\page.html now.");
assert(
  linkedWindowsHtml.includes("](C:%5CUsers%5CUser%5CDocuments%5CNew%20project%203%5Cpage.html)"),
  "Windows HTML paths with spaces become preview links",
);
const fenced = linkifyPreviewableFileRefs("```bash\ncat shellx-preview-test.html\n```\n");
assert(
  fenced === "```bash\ncat shellx-preview-test.html\n```\n",
  "code fences are not linkified",
);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} markdown-link tests`);
process.exit(failures === 0 ? 0 : 1);
