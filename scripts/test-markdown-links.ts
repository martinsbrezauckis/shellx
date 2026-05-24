import {
  fileDisplayName,
  isPreviewableFileHref,
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

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} markdown-link tests`);
process.exit(failures === 0 ? 0 : 1);
