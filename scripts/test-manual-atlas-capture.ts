import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  captureManualAtlas,
  type ManualAtlasCaptureAdapter,
  type ManualAtlasCaptureTarget,
} from "./lib/manual-atlas-capture";
import { MANUAL_ATLAS_CAPTURE_PLAN, type ManualAtlasCaptureSurface } from "./lib/manual-atlas-capture-plan";

const root = resolve(import.meta.dirname, "..");
const visuals = JSON.parse(readFileSync(resolve(root, "docs/public/manual/shellx/visuals.json"), "utf8")) as {
  captures: Record<string, ManualAtlasCaptureTarget>;
};
const selectedSurfaces: ManualAtlasCaptureSurface[] = [];
const patches: Array<{ surface: ManualAtlasCaptureSurface; body: Record<string, unknown> }> = [];
const clicks: string[] = [];
const waits: string[] = [];
const scrolls: string[] = [];
const saved = new Map<string, Buffer>();
let width = 0;
let height = 0;

const adapter: ManualAtlasCaptureAdapter = {
  async selectSurface(surface) {
    selectedSurfaces.push(surface);
  },
  async setWindowSize(nextWidth, nextHeight) {
    width = nextWidth;
    height = nextHeight;
  },
  async postPatch(surface, body) {
    patches.push({ surface, body });
  },
  async click(selector) {
    clicks.push(selector);
  },
  async waitForSelector(selector) {
    waits.push(selector);
  },
  async scroll(selector, edge) {
    scrolls.push(`${selector}:${edge}`);
  },
  async screenshot() {
    return fixturePng(width, height);
  },
  async saveCapture(file, bytes) {
    assert(!saved.has(file), `capture file ${file} must be written once`);
    saved.set(file, bytes);
  },
  async settle() {},
};

const manifest = await captureManualAtlas({
  plan: MANUAL_ATLAS_CAPTURE_PLAN,
  targets: visuals.captures,
  candidate: {
    sourceCommit: "a".repeat(40),
    productSourceSha256: "c".repeat(64),
    version: "0.3.5",
    platform: "linux-installed",
  },
  adapter,
  createdAt: "2026-07-30T00:00:00.000Z",
});

assert.equal(manifest.status, "captured-unreviewed", "capture alone never claims visual review");
assert.equal(manifest.captureCount, 37);
assert.equal(Object.keys(manifest.captures).length, 37);
assert.equal(saved.size, 37);
assert.equal(selectedSurfaces.filter((surface) => surface === "app").length, 23);
assert.equal(selectedSurfaces.filter((surface) => surface === "browser").length, 14);
assert(patches.some(({ body }) => body.debugSurface === "app"));
assert(clicks.includes("[data-debug-id='shellx-browser-right-tab-chat']"));
assert(clicks.includes("[data-debug-id='shellx-browser-downloads-menu']"));
assert(waits.includes("[role='dialog'][aria-label='Attachment and media board']"));
assert.deepEqual(scrolls, ["#shellx-browser-save-menu:top", "#shellx-browser-save-menu:bottom"]);
assert.equal(manifest.captures["shellx-workspace"]?.width, 1920);
assert.equal(manifest.captures["browser-overview"]?.height, 1000);
assert.match(manifest.captures["browser-overview"]?.sha256 ?? "", /^[a-f0-9]{64}$/);

await assert.rejects(
  captureManualAtlas({
    plan: [MANUAL_ATLAS_CAPTURE_PLAN[0]!],
    targets: {
      "shellx-workspace": visuals.captures["shellx-workspace"]!,
    },
    candidate: {
      sourceCommit: "b".repeat(40),
      productSourceSha256: "d".repeat(64),
      version: "0.3.5",
      platform: "linux-installed",
    },
    adapter: {
      ...adapter,
      async screenshot() {
        return fixturePng(1600, 1000);
      },
    },
  }),
  /captured PNG is 1600x1000; expected 1920x1200/,
  "capture dimensions fail closed before promotion",
);

console.log("Manual atlas installed-candidate capture runner passed: 37 hashed, unreviewed states");

function fixturePng(pngWidth: number, pngHeight: number): Buffer {
  const png = Buffer.alloc(10_024);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(pngWidth, 16);
  png.writeUInt32BE(pngHeight, 20);
  return png;
}
