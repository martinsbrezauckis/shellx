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
  resolveMarkdownPreviewHref("C:\\Users\\FixtureUser\\repo\\docs\\guide.md", "..\\src\\main.ts") === "C:\\Users\\FixtureUser\\repo\\src\\main.ts",
  "Windows relative markdown link normalizes parent segments",
);
assert(
  resolveMarkdownPreviewHref(undefined, "/home/user/src/App.tsx:42") === "/home/user/src/App.tsx",
  "POSIX file link strips trailing line suffix",
);
assert(
  resolveMarkdownPreviewHref(undefined, "C:\\Users\\FixtureUser\\shellX\\src\\App.tsx:42:7") === "C:\\Users\\FixtureUser\\shellX\\src\\App.tsx",
  "Windows file link strips trailing line and column suffix",
);
assert(
  fileDisplayName("C:\\Users\\FixtureUser\\shellX\\docs\\Goal Plan.md:12") === "Goal Plan.md",
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
const encodedGrokSessionMarkdownPath =
  "C:\\Users\\FixtureUser\\.grok\\sessions\\C%3A%5CUsers%5CFixtureUser\\019e7aab-e6c4-7cd3-8dbf-be10b70f2737\\plan.md";
assert(
  localHrefToPreviewPath(encodedGrokSessionMarkdownPath) === encodedGrokSessionMarkdownPath,
  "encoded Grok session markdown paths stay byte-identical so plan.md preview can read the real file",
);
assert(
  resolveMarkdownPreviewHref(undefined, encodedGrokSessionMarkdownPath) === encodedGrokSessionMarkdownPath,
  "encoded Grok session markdown hrefs are not decoded before Preview Center",
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
const linkedBareAgents = linkifyPreviewableFileRefs("Diagnostics checked Agents.md before continuing.");
assert(
  linkedBareAgents === "Diagnostics checked Agents.md before continuing.",
  "bare markdown prose references are not auto-linkified as cwd files",
);
const linkedBarePlan = linkifyPreviewableFileRefs("Updated plan.md after the build.");
assert(
  linkedBarePlan.includes("[plan.md](plan.md)"),
  "bare plan.md remains preview-linked as a session artifact",
);
const linkedRelativeAgents = linkifyPreviewableFileRefs("Read ./AGENTS.md before editing.");
assert(
  linkedRelativeAgents.includes("[./AGENTS.md](./AGENTS.md)"),
  "explicit relative markdown paths stay preview-linked",
);
const linkedLocalhostUrl = linkifyPreviewableFileRefs(
  "Quick access: Selector: http://127.0.0.1:61322/shellx-redesigns.html",
);
assert(
  linkedLocalhostUrl === "Quick access: Selector: http://127.0.0.1:61322/shellx-redesigns.html",
  "localhost URLs are not partially linkified as preview files",
);
const linkedRemoteUrl = linkifyPreviewableFileRefs("Open https://example.com/shellx-redesigns.html");
assert(
  linkedRemoteUrl === "Open https://example.com/shellx-redesigns.html",
  "remote URLs are not partially linkified as preview files",
);
const linkedBareLocalhostUrl = linkifyPreviewableFileRefs("Open 127.0.0.1:61322/shellx-redesigns.html");
assert(
  linkedBareLocalhostUrl === "Open 127.0.0.1:61322/shellx-redesigns.html",
  "scheme-less localhost URLs are not partially linkified as preview files",
);
const linkedWindowsHtml = linkifyPreviewableFileRefs("Open C:\\Users\\FixtureUser\\Documents\\New project 3\\page.html now.");
assert(
  linkedWindowsHtml.includes("](C:%5CUsers%5CFixtureUser%5CDocuments%5CNew%20project%203%5Cpage.html)"),
  "Windows HTML paths with spaces become preview links",
);
const linkedTildeMarkdown = linkifyPreviewableFileRefs("Open ~/shellx-sample/sample.md after the run.");
assert(
  linkedTildeMarkdown.includes("[~/shellx-sample/sample.md](~/shellx-sample/sample.md)"),
  "tilde-prefixed POSIX file paths are linked as a whole path",
);
const fenced = linkifyPreviewableFileRefs("```bash\ncat shellx-preview-test.html\n```\n");
assert(
  fenced === "```bash\ncat shellx-preview-test.html\n```\n",
  "code fences are not linkified",
);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} markdown-link tests`);
process.exit(failures === 0 ? 0 : 1);
