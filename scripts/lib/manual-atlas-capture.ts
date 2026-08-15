import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  ManualAtlasCapturePlanEntry,
  ManualAtlasCaptureSurface,
} from "./manual-atlas-capture-plan";

export const MANUAL_ATLAS_CAPTURE_MANIFEST_SCHEMA = "shellx/manual-atlas-capture@2" as const;

export interface ManualAtlasCaptureTarget {
  file: string;
  width: number;
  height: number;
}

export interface ManualAtlasCandidateIdentity {
  sourceCommit: string;
  productSourceSha256: string;
  version: string;
  platform: string;
}

export interface ManualAtlasCaptureAdapter {
  selectSurface(surface: ManualAtlasCaptureSurface): Promise<void>;
  setWindowSize(width: number, height: number): Promise<void>;
  postPatch(surface: ManualAtlasCaptureSurface, body: Record<string, unknown>): Promise<void>;
  click(selector: string): Promise<void>;
  waitForSelector(selector: string): Promise<void>;
  reveal(selector: string, block: "start" | "center" | "end"): Promise<void>;
  scroll(selector: string, edge: "top" | "bottom"): Promise<void>;
  screenshot(): Promise<Buffer>;
  saveCapture(file: string, bytes: Buffer): Promise<void>;
  settle(): Promise<void>;
}

export interface ManualAtlasCaptureManifest {
  schema: typeof MANUAL_ATLAS_CAPTURE_MANIFEST_SCHEMA;
  status: "captured-unreviewed";
  candidate: ManualAtlasCandidateIdentity;
  createdAt: string;
  captureCount: number;
  captures: Record<string, {
    file: string;
    width: number;
    height: number;
    bytes: number;
    sha256: string;
    intendedState: string;
  }>;
}

export async function captureManualAtlas(input: {
  plan: readonly ManualAtlasCapturePlanEntry[];
  targets: Readonly<Record<string, ManualAtlasCaptureTarget>>;
  candidate: ManualAtlasCandidateIdentity;
  adapter: ManualAtlasCaptureAdapter;
  createdAt?: string;
}): Promise<ManualAtlasCaptureManifest> {
  validateCandidate(input.candidate);
  const planIds = input.plan.map((entry) => entry.id);
  if (planIds.length === 0 || new Set(planIds).size !== planIds.length) {
    throw new Error("manual atlas capture plan must contain unique entries");
  }
  const targetIds = Object.keys(input.targets);
  if (targetIds.length !== planIds.length
    || targetIds.some((id) => !planIds.includes(id))) {
    throw new Error("manual atlas capture targets must exactly match the capture plan");
  }

  const captures: ManualAtlasCaptureManifest["captures"] = {};
  for (const entry of input.plan) {
    const target = input.targets[entry.id];
    if (!target) throw new Error(`manual atlas target is missing for ${entry.id}`);
    validateTarget(entry.id, target);
    await input.adapter.selectSurface(entry.surface);
    await input.adapter.setWindowSize(target.width, target.height);
    for (const step of entry.steps) {
      if (step.kind === "patch") {
        await input.adapter.postPatch(step.surface, step.body);
      } else if (step.kind === "click") {
        await input.adapter.click(step.selector);
      } else if (step.kind === "wait") {
        await input.adapter.waitForSelector(step.selector);
      } else if (step.kind === "reveal") {
        await input.adapter.reveal(step.selector, step.block);
      } else {
        await input.adapter.scroll(step.selector, step.edge);
      }
    }
    await input.adapter.settle();
    const png = await input.adapter.screenshot();
    const dimensions = readPngDimensions(png);
    if (dimensions.width !== target.width || dimensions.height !== target.height) {
      throw new Error(
        `${entry.id}: captured PNG is ${dimensions.width}x${dimensions.height}; expected ${target.width}x${target.height}`,
      );
    }
    const file = basename(target.file);
    await input.adapter.saveCapture(file, png);
    captures[entry.id] = {
      file,
      width: dimensions.width,
      height: dimensions.height,
      bytes: png.length,
      sha256: createHash("sha256").update(png).digest("hex"),
      intendedState: entry.intendedState,
    };
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("manual atlas capture timestamp is invalid");
  return {
    schema: MANUAL_ATLAS_CAPTURE_MANIFEST_SCHEMA,
    status: "captured-unreviewed",
    candidate: input.candidate,
    createdAt,
    captureCount: planIds.length,
    captures,
  };
}

export function readPngDimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    || png.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("manual atlas capture is not a PNG with an IHDR header");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 7_680 || height > 4_320) {
    throw new Error("manual atlas PNG dimensions are outside the accepted bounds");
  }
  return { width, height };
}

function validateCandidate(candidate: ManualAtlasCandidateIdentity): void {
  if (!/^[a-f0-9]{40,64}$/.test(candidate.sourceCommit)) {
    throw new Error("manual atlas candidate source commit must be an exact Git object id");
  }
  if (!/^[a-f0-9]{64}$/.test(candidate.productSourceSha256)) {
    throw new Error("manual atlas candidate product source digest must be SHA-256");
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(candidate.version)) {
    throw new Error("manual atlas candidate version must be a bounded semantic version");
  }
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(candidate.platform)) {
    throw new Error("manual atlas candidate platform is invalid");
  }
}

function validateTarget(id: string, target: ManualAtlasCaptureTarget): void {
  if (!/^[a-z0-9][a-z0-9-]{1,127}$/.test(id)) throw new Error(`invalid manual atlas capture id: ${id}`);
  if (!/^assets\/[a-z0-9][a-z0-9-]{1,127}\.png$/.test(target.file)
    || !/^[a-z0-9][a-z0-9-]{1,127}\.png$/.test(basename(target.file))) {
    throw new Error(`${id}: manual atlas capture file must be a safe assets PNG path`);
  }
  if (!Number.isSafeInteger(target.width) || target.width < 800 || target.width > 7_680
    || !Number.isSafeInteger(target.height) || target.height < 600 || target.height > 4_320) {
    throw new Error(`${id}: manual atlas capture dimensions are invalid`);
  }
}
