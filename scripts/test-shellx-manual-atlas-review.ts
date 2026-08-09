import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateManualAtlasReview, type ManualAtlasVisuals } from "./lib/manual-atlas-review";

const leftRailSource = readFileSync(new URL("../src/components/LeftRail.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
assert(leftRailSource.includes('const historyDisplayPath = "~/.shellx/sessions/"'));
assert(leftRailSource.includes("}>{historyDisplayPath}</span>"));
assert(!leftRailSource.includes("}>{sessionLogPath}</span>"));
assert(!leftRailSource.includes('direction: "rtl"'));
assert(leftRailSource.includes('query.set("cwd", cwd.trim())'));
assert(appSource.includes("cwd={activeTab?.cwd ?? cwd}"));

const sha256 = "a".repeat(64);
const valid: ManualAtlasVisuals = {
  revalidation: {
    status: "reviewed",
    sourceCommit: "e".repeat(40),
    productSourceSha256: "c".repeat(64),
    reviewedAt: "2026-08-08T00:00:00.000Z",
    evidenceSha256: "d".repeat(64),
  },
  captures: {
    "settings-about": {
      file: "assets/settings-about.png",
      width: 1920,
      height: 1200,
      kind: "installed-candidate",
      review: {
        status: "reviewed",
        source: "installed-tauri",
        sourceCommit: "f".repeat(40),
        productSourceSha256: "c".repeat(64),
        appVersion: "0.3.5",
        platform: "windows-installed",
        sha256,
        intendedState: "Production About tab with bound ports and no internal release panel.",
        reviewedAt: "2026-07-30T00:00:00.000Z",
      },
    },
  },
  features: {
    "shellx.interface.settings.about": { capture: "settings-about" },
  },
};

assert.deepEqual(
  validateManualAtlasReview({
    visuals: valid,
    imageSha256: new Map([["assets/settings-about.png", sha256]]),
    expectedProductSourceSha256: "c".repeat(64),
    expectedAppVersion: "0.3.5",
  }),
  [],
  "a reviewed installed-Tauri capture bound to the exact bytes passes",
);

const changedBytes = validateManualAtlasReview({
  visuals: valid,
  imageSha256: new Map([["assets/settings-about.png", "b".repeat(64)]]),
  expectedProductSourceSha256: "c".repeat(64),
  expectedAppVersion: "0.3.5",
});
assert(changedBytes.some((error) => error.includes("changed after visual review")), "image drift invalidates review");

const staleRevalidation = structuredClone(valid);
staleRevalidation.revalidation.productSourceSha256 = "b".repeat(64);
assert(
  validateManualAtlasReview({ visuals: staleRevalidation, imageSha256: new Map([["assets/settings-about.png", sha256]]), expectedProductSourceSha256: "c".repeat(64), expectedAppVersion: "0.3.5" })
    .some((error) => error.includes("revalidation belongs to different product source bytes")),
  "a stale visual revalidation digest fails closed",
);

const previewVisuals = structuredClone(valid);
previewVisuals.captures["settings-about"]!.kind = "source-candidate";
previewVisuals.captures["settings-about"]!.review!.source = "installed-tauri";
assert(
  validateManualAtlasReview({ visuals: previewVisuals, imageSha256: new Map([["assets/settings-about.png", sha256]]), expectedProductSourceSha256: "c".repeat(64), expectedAppVersion: "0.3.5" })
    .some((error) => error.includes("kind must be installed-candidate")),
  "browser/source preview captures cannot pass the release atlas gate",
);

const blockedVisuals = structuredClone(valid);
blockedVisuals.captures["settings-about"]!.review!.status = "blocked";
assert(
  validateManualAtlasReview({ visuals: blockedVisuals, imageSha256: new Map([["assets/settings-about.png", sha256]]), expectedProductSourceSha256: "c".repeat(64), expectedAppVersion: "0.3.5" })
    .some((error) => error.includes("status must be reviewed")),
  "an explicitly blocked capture remains a release blocker",
);

const missingReview = structuredClone(valid);
delete missingReview.captures["settings-about"]!.review;
assert(
  validateManualAtlasReview({ visuals: missingReview, imageSha256: new Map([["assets/settings-about.png", sha256]]), expectedProductSourceSha256: "c".repeat(64), expectedAppVersion: "0.3.5" })
    .some((error) => error.includes("metadata is missing")),
  "unreviewed capture metadata fails closed",
);

const orphan = structuredClone(valid);
orphan.captures.orphan = structuredClone(orphan.captures["settings-about"]!);
orphan.captures.orphan.file = "assets/orphan.png";
assert(
  validateManualAtlasReview({ visuals: orphan, imageSha256: new Map([
    ["assets/settings-about.png", sha256],
    ["assets/orphan.png", sha256],
  ]), expectedProductSourceSha256: "c".repeat(64), expectedAppVersion: "0.3.5" }).some((error) => error.includes("not used by any documented feature")),
  "unused promoted captures fail closed",
);

console.log("ShellX manual atlas review contract tests passed");
