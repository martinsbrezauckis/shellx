export const MANUAL_ATLAS_REVIEW_SOURCE = "installed-tauri" as const;
export const MANUAL_ATLAS_CAPTURE_KIND = "installed-candidate" as const;

export interface ManualAtlasCaptureReview {
  status: "reviewed" | "blocked";
  source: typeof MANUAL_ATLAS_REVIEW_SOURCE;
  sourceCommit: string;
  productSourceSha256: string;
  appVersion: string;
  platform: string;
  sha256: string;
  intendedState: string;
  reviewedAt: string;
}

export interface ManualAtlasCapture {
  file: string;
  width: number;
  height: number;
  kind: string;
  review?: ManualAtlasCaptureReview;
}

export interface ManualAtlasVisuals {
  revalidation: {
    status: "reviewed";
    sourceCommit: string;
    productSourceSha256: string;
    reviewedAt: string;
    evidenceSha256: string;
  };
  captures: Record<string, ManualAtlasCapture>;
  features: Record<string, { capture: string }>;
}

const SHA256 = /^[a-f0-9]{64}$/;

export function validateManualAtlasReview(input: {
  visuals: ManualAtlasVisuals;
  imageSha256: ReadonlyMap<string, string>;
  expectedProductSourceSha256: string;
  expectedAppVersion: string;
}): string[] {
  const errors: string[] = [];
  const revalidation = input.visuals.revalidation;
  if (!revalidation || revalidation.status !== "reviewed") {
    errors.push("manual atlas revalidation status must be reviewed");
  } else {
    if (!/^[a-f0-9]{40,64}$/.test(revalidation.sourceCommit ?? "")) {
      errors.push("manual atlas revalidation sourceCommit must be an exact Git object id");
    }
    if (revalidation.productSourceSha256 !== input.expectedProductSourceSha256) {
      errors.push("manual atlas revalidation belongs to different product source bytes");
    }
    if (!Number.isFinite(Date.parse(revalidation.reviewedAt ?? ""))) {
      errors.push("manual atlas revalidation reviewedAt must be a valid ISO timestamp");
    }
    if (!SHA256.test(revalidation.evidenceSha256 ?? "")) {
      errors.push("manual atlas revalidation evidenceSha256 is invalid");
    }
  }
  const captureIds = Object.keys(input.visuals.captures ?? {}).sort();
  if (captureIds.length === 0) return ["manual atlas has no captures"];

  const usedCaptureIds = new Set(
    Object.values(input.visuals.features ?? {}).map((feature) => feature.capture),
  );
  for (const captureId of captureIds) {
    const capture = input.visuals.captures[captureId];
    if (!capture) continue;
    if (!usedCaptureIds.has(captureId)) {
      errors.push(`${captureId}: capture is not used by any documented feature`);
    }
    if (capture.kind !== MANUAL_ATLAS_CAPTURE_KIND) {
      errors.push(`${captureId}: kind must be ${MANUAL_ATLAS_CAPTURE_KIND}`);
    }
    const review = capture.review;
    if (!review) {
      errors.push(`${captureId}: reviewed image metadata is missing`);
      continue;
    }
    if (review.status !== "reviewed") {
      errors.push(`${captureId}: review status must be reviewed`);
    }
    if (review.source !== MANUAL_ATLAS_REVIEW_SOURCE) {
      errors.push(`${captureId}: review source must be ${MANUAL_ATLAS_REVIEW_SOURCE}`);
    }
    if (!/^[a-f0-9]{40,64}$/.test(review.sourceCommit ?? "")) {
      errors.push(`${captureId}: sourceCommit must be an exact Git object id`);
    }
    if (!SHA256.test(review.productSourceSha256 ?? "")) {
      errors.push(`${captureId}: productSourceSha256 is invalid`);
    } else if (review.productSourceSha256 !== input.expectedProductSourceSha256) {
      errors.push(`${captureId}: capture belongs to different product source bytes`);
    }
    if (review.appVersion !== input.expectedAppVersion) {
      errors.push(`${captureId}: capture appVersion must be ${input.expectedAppVersion}`);
    }
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(review.platform ?? "")) {
      errors.push(`${captureId}: capture platform is invalid`);
    }
    if (!SHA256.test(review.sha256)) {
      errors.push(`${captureId}: reviewed SHA-256 is invalid`);
    }
    const actualSha256 = input.imageSha256.get(capture.file);
    if (!actualSha256) {
      errors.push(`${captureId}: capture file is missing from the review input`);
    } else if (review.sha256 !== actualSha256) {
      errors.push(`${captureId}: capture bytes changed after visual review`);
    }
    if (typeof review.intendedState !== "string" || review.intendedState.trim().length < 24) {
      errors.push(`${captureId}: intended state must explain the visible UI state`);
    }
    if (!Number.isFinite(Date.parse(review.reviewedAt))) {
      errors.push(`${captureId}: reviewedAt must be a valid ISO timestamp`);
    }
  }

  for (const [featureId, feature] of Object.entries(input.visuals.features ?? {})) {
    if (!input.visuals.captures[feature.capture]) {
      errors.push(`${featureId}: feature references missing capture ${feature.capture}`);
    }
  }
  return errors;
}
