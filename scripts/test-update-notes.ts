import { cleanUpdateNotes, firstUpdateNotesUrl } from "../src/lib/update-notes";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

const rawNotes = [
  "See the [CHANGELOG](https://github.com/martinsbrezauckis/shellx/blob/8035b3e3d34c3d08e4dfdf0254786815364b09dd/CHANGELOG.md) for what's new.",
  "",
  "This draft is not visible to auto-update clients until the release is published.",
].join("\n");

const cleaned = cleanUpdateNotes(rawNotes);

console.log("\n=== update notes normalization ===");
assert(!cleaned.includes("This draft is not visible"), "stale draft visibility note is stripped");
assert(cleaned.startsWith("See the [CHANGELOG]"), "changelog markdown remains intact");
assert(
  firstUpdateNotesUrl(rawNotes) ===
    "https://github.com/martinsbrezauckis/shellx/blob/8035b3e3d34c3d08e4dfdf0254786815364b09dd/CHANGELOG.md",
  "first markdown URL is extracted for compact update surfaces",
);
assert(firstUpdateNotesUrl("No links here") === null, "missing links return null");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} update-notes tests`);
process.exit(failures === 0 ? 0 : 1);
