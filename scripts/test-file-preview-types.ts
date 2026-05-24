import {
  previewKindForPath,
  shouldReadTextForPreviewKind,
  shikiLangForPath,
} from "../src/lib/file-preview-types";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== file preview type detection ===");

assert(previewKindForPath("/repo/.env.local") === "code", ".env.local previews as code");
assert(previewKindForPath("/repo/.gitignore") === "code", ".gitignore previews as code");
assert(previewKindForPath("/repo/CODEOWNERS") === "code", "CODEOWNERS previews as code");
assert(previewKindForPath("/repo/Dockerfile.dev") === "code", "Dockerfile.dev previews as code");
assert(previewKindForPath("C:\\repo\\src\\env.d.ts") === "code", ".d.ts previews as code");
assert(previewKindForPath("/repo/public/index.html") === "html", ".html gets code/preview toggle");
assert(previewKindForPath("/repo/public/index.htm") === "html", ".htm gets code/preview toggle");
assert(previewKindForPath("/repo/infra/main.tfvars") === "code", ".tfvars previews as code");
assert(previewKindForPath("/repo/changes/feature.patch") === "code", ".patch previews as code");
assert(previewKindForPath("/repo/scripts/setup.bat") === "code", ".bat previews as code");
assert(previewKindForPath("/repo/scripts/setup.cmd") === "code", ".cmd previews as code");
assert(previewKindForPath("/repo/shell.nix") === "code", ".nix previews as code");
assert(previewKindForPath("/repo/app.env") === "code", ".env extension previews as code");
assert(previewKindForPath("/repo/report.xlsx") === "unknown", ".xlsx is not text-previewable");
assert(previewKindForPath("/repo/notes.md?raw=1") === "markdown", "query strings do not hide markdown extension");
assert(previewKindForPath("/repo/movie.mp4#t=1") === "video", "hash suffixes do not hide video extension");

assert(shouldReadTextForPreviewKind("markdown"), "markdown reads text");
assert(shouldReadTextForPreviewKind("html"), "html reads text for code and sandboxed output preview");
assert(shouldReadTextForPreviewKind("code"), "code reads text");
assert(shouldReadTextForPreviewKind("text"), "text reads text");
assert(!shouldReadTextForPreviewKind("unknown"), "unknown files do not dump binary as text");
assert(!shouldReadTextForPreviewKind("pdf"), "pdf uses binary preview path");

assert(shikiLangForPath("/repo/.env.local") === "dotenv", ".env.local highlights as dotenv");
assert(shikiLangForPath("/repo/.gitignore") === null, ".gitignore uses plain code preview when Shiki has no grammar");
assert(shikiLangForPath("/repo/public/index.htm") === "html", ".htm highlights as html");
assert(shikiLangForPath("/repo/Dockerfile.dev") === "dockerfile", "Dockerfile.dev highlights as dockerfile");
assert(shikiLangForPath("C:\\repo\\src\\env.d.ts") === "typescript", ".d.ts highlights as typescript");
assert(shikiLangForPath("/repo/app.astro") === "astro", ".astro highlights as astro");
assert(shikiLangForPath("/repo/infra/main.tf") === "terraform", ".tf highlights as terraform");
assert(shikiLangForPath("/repo/changes/feature.diff") === "diff", ".diff highlights as diff");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} file-preview type tests`);
process.exit(failures === 0 ? 0 : 1);
