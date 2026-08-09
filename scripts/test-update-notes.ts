import { readFileSync } from "node:fs";
import {
  cleanUpdateNotes,
  firstUpdateNotesUrl,
} from "../src/lib/update-notes";

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
const updaterSurfaces = [
  readFileSync("src/components/UpdateBanner.tsx", "utf8"),
  readFileSync("src/components/RightRail.tsx", "utf8"),
  readFileSync("src/components/settings/AboutTab.tsx", "utf8"),
];
assert(
  updaterSurfaces.every((source) => source.includes("DEBUG_UPDATE_INSTALL_RECEIPT")),
  "all updater install surfaces stop at the shared isolated pre-download receipt",
);
assert(
  updaterSurfaces.slice(1).every((source) => source.includes("DEBUG_UPDATE_CHECK_RECEIPT")),
  "both user-invoked updater check surfaces use the shared isolated receipt",
);
assert(
  updaterSurfaces.every((source) => source.includes("data-release-update-receipt"))
    && updaterSurfaces.every((source) => source.includes('data-shellx-release-observe="title"')),
  "all updater surfaces expose only bounded non-sensitive release receipts",
);
assert(firstUpdateNotesUrl("No links here") === null, "missing links return null");
assert(
  firstUpdateNotesUrl("See https://attacker.example/fake-shellx-notes") === null,
  "untrusted manifest notes cannot create a phishing link",
);
assert(
  firstUpdateNotesUrl("See http://github.com/martinsbrezauckis/shellx/releases") === null,
  "release notes links require HTTPS",
);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} update-notes tests`);
process.exit(failures === 0 ? 0 : 1);
