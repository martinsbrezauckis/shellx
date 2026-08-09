import type {
  ReleaseSurfaceItem,
  ReleaseUiDriverFamily,
  ReleaseUiInteractionFamily,
} from "./release-surface-inventory";

export const RELEASE_UI_DRIVER_FAMILY_CONTRACT_SCHEMA = "shellx/release-ui-driver-family-contract@1";

export type ReleaseUiInvocationKind =
  | "native-pointer-or-keyboard"
  | "native-keyboard-input"
  | "native-form-input"
  | "native-file-chooser"
  | "none";

export type ReleaseUiEffectProof =
  | "selected-owner-state"
  | "expanded-owned-content"
  | "boolean-and-backing-state"
  | "value-and-backing-state"
  | "choice-and-backing-state"
  | "range-and-backing-state"
  | "attachment-identity"
  | "typed-semantic-effect"
  | "visible-nonempty-rectangle";

export interface ReleaseUiDriverFamilyContract {
  schema: typeof RELEASE_UI_DRIVER_FAMILY_CONTRACT_SCHEMA;
  family: ReleaseUiDriverFamily;
  surfaceKind: "ui-control" | "ui-debug-surface";
  invocation: ReleaseUiInvocationKind;
  effectProof: ReleaseUiEffectProof;
  baseOracleId: string;
  cleanupProof: "restore-baseline" | "remove-owned-attachment" | "clear-debug-highlight";
  requiresBackingState: boolean;
  requiresSpecializedOracle: boolean;
}

export const RELEASE_UI_DRIVER_FAMILY_CONTRACTS: Readonly<Record<ReleaseUiDriverFamily, ReleaseUiDriverFamilyContract>> = {
  selection: controlContract("selection", "native-pointer-or-keyboard", "selected-owner-state", "ui:selection-state-transition", true),
  disclosure: controlContract("disclosure", "native-pointer-or-keyboard", "expanded-owned-content", "ui:disclosure-state-transition", false),
  toggle: controlContract("toggle", "native-pointer-or-keyboard", "boolean-and-backing-state", "ui:boolean-state-transition", true),
  "text-entry": controlContract("text-entry", "native-keyboard-input", "value-and-backing-state", "ui:value-state-transition", true),
  choice: controlContract("choice", "native-form-input", "choice-and-backing-state", "ui:choice-state-transition", true),
  range: controlContract("range", "native-form-input", "range-and-backing-state", "ui:range-state-transition", true),
  "file-picker": {
    ...controlContract("file-picker", "native-file-chooser", "attachment-identity", "ui:file-attachment-transition", true),
    cleanupProof: "remove-owned-attachment",
  },
  activation: {
    ...controlContract("activation", "native-pointer-or-keyboard", "typed-semantic-effect", "ui:activation:", true),
    requiresSpecializedOracle: true,
  },
  "static-marker": debugContract("static-marker"),
  "dynamic-marker": debugContract("dynamic-marker"),
};

export function releaseUiDriverFamilyContract(surface: ReleaseSurfaceItem): ReleaseUiDriverFamilyContract {
  if (surface.kind !== "ui-control" && surface.kind !== "ui-debug-surface") {
    throw new Error(`${surface.id} is not a UI surface`);
  }
  if (!surface.driverFamily) throw new Error(`${surface.id} does not declare a UI driver family`);
  return RELEASE_UI_DRIVER_FAMILY_CONTRACTS[surface.driverFamily];
}

export function validateReleaseUiSurfaceMetadata(surface: ReleaseSurfaceItem): string[] {
  if (surface.kind !== "ui-control" && surface.kind !== "ui-debug-surface") return [];
  const errors: string[] = [];
  if (!surface.driverFamily) return [`${surface.id} does not declare a UI driver family`];
  const contract = RELEASE_UI_DRIVER_FAMILY_CONTRACTS[surface.driverFamily];
  if (contract.surfaceKind !== surface.kind) {
    errors.push(`${surface.id} uses ${surface.driverFamily}, which belongs to ${contract.surfaceKind}`);
  }
  if (surface.kind === "ui-control") {
    if (!surface.elementTag?.trim()) errors.push(`${surface.id} does not declare its intrinsic element tag`);
    if (surface.eventTrust !== "native-required") {
      errors.push(`${surface.id} must require native final-gate event delivery`);
    }
    if (surface.driverFamily === "file-picker" && !(surface.elementTag === "input" && surface.inputType === "file")) {
      errors.push(`${surface.id} is classified as a file picker without input[type=file]`);
    }
  } else {
    if (surface.eventTrust !== "not-applicable") {
      errors.push(`${surface.id} is an addressability marker and must not claim a user-event proof`);
    }
    const expected = surface.dynamicSelector ? "dynamic-marker" : "static-marker";
    if (surface.driverFamily !== expected) {
      errors.push(`${surface.id} must use ${expected} for its selector shape`);
    }
  }
  return errors;
}

export function validateReleaseUiControlOracle(surface: ReleaseSurfaceItem, oracleId: string): string[] {
  if (surface.kind !== "ui-control") return [];
  const contract = releaseUiDriverFamilyContract(surface);
  if (contract.requiresSpecializedOracle) {
    if (!oracleId.startsWith(contract.baseOracleId) || oracleId.length <= contract.baseOracleId.length) {
      return [`${surface.id} requires a typed activation oracle below ${contract.baseOracleId}`];
    }
    if (oracleId.includes("visible") || oracleId.includes("rectangle")) {
      return [`${surface.id} activation cannot use visibility as its semantic effect oracle`];
    }
    return [];
  }
  return oracleId === contract.baseOracleId
    ? []
    : [`${surface.id} requires family oracle ${contract.baseOracleId}`];
}

function controlContract(
  family: ReleaseUiInteractionFamily,
  invocation: Exclude<ReleaseUiInvocationKind, "none">,
  effectProof: Exclude<ReleaseUiEffectProof, "visible-nonempty-rectangle">,
  baseOracleId: string,
  requiresBackingState: boolean,
): ReleaseUiDriverFamilyContract {
  return {
    schema: RELEASE_UI_DRIVER_FAMILY_CONTRACT_SCHEMA,
    family,
    surfaceKind: "ui-control",
    invocation,
    effectProof,
    baseOracleId,
    cleanupProof: "restore-baseline",
    requiresBackingState,
    requiresSpecializedOracle: false,
  };
}

function debugContract(family: "static-marker" | "dynamic-marker"): ReleaseUiDriverFamilyContract {
  return {
    schema: RELEASE_UI_DRIVER_FAMILY_CONTRACT_SCHEMA,
    family,
    surfaceKind: "ui-debug-surface",
    invocation: "none",
    effectProof: "visible-nonempty-rectangle",
    baseOracleId: "ui:visible-nonempty-rectangle",
    cleanupProof: "clear-debug-highlight",
    requiresBackingState: false,
    requiresSpecializedOracle: false,
  };
}
