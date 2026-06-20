export type ModelInstructionRouteMode = "explicitOnly" | string;

export interface ModelRoutingPolicySummary {
  shellxMayAutoRoute: boolean;
  defaultRouteMode: ModelInstructionRouteMode;
  defaultToolExposureMode: ModelToolExposureMode;
  toolExposureModes: ToolExposureModeSummary[];
  fallbackRule: string;
  operatorRule: string;
}

export type ModelToolExposureMode = "nativeFirst" | "hostBridge" | "hostFull" | "off" | string;

export interface ToolExposureModeSummary {
  id: ModelToolExposureMode;
  label: string;
  description: string;
  agentRule: string;
}

export interface ModelInstructionCardsState {
  version: string;
  lastReviewed: string;
  policy: ModelRoutingPolicySummary;
  cards: ModelInstructionCard[];
}

export interface ModelInstructionCard {
  id: string;
  displayName: string;
  providerId: string;
  category: string;
  status: string;
  routeMode: ModelInstructionRouteMode;
  shellxMayAutoRoute: boolean;
  intentExamples: string[];
  preflightChecks: CardPreflightCheck[];
  capabilities: CardCapability[];
  toolExposure: CardToolExposurePolicy;
  invocation: CardInvocation;
  agentInstructions: string[];
  receiptKinds: string[];
  fallbackRule: string;
  provenance: CardProvenance;
}

export interface CardPreflightCheck {
  id: string;
  label: string;
  required: boolean;
}

export interface CardCapability {
  id: string;
  label: string;
  level: string;
  notes: string;
}

export interface CardToolExposurePolicy {
  defaultMode: ModelToolExposureMode;
  nativeToolRule: string;
  shellxToolRule: string;
  allowedShellxTools: string[];
}

export interface CardInvocation {
  surface: string;
  debugApiPath?: string;
  commandHint?: string;
  requiresUserVisibleSelection: boolean;
}

export interface CardProvenance {
  source: string;
  refreshHint: string;
}

export function modelInstructionCardsPath(): string {
  return "/state/model_instruction_cards";
}

export function findModelInstructionCard(
  state: ModelInstructionCardsState,
  id: string,
): ModelInstructionCard | undefined {
  return state.cards.find((card) => card.id === id);
}

export function isExplicitOnlyCard(card: ModelInstructionCard): boolean {
  return card.routeMode === "explicitOnly" && card.shellxMayAutoRoute === false;
}

export function requiredPreflightIds(card: ModelInstructionCard): string[] {
  return card.preflightChecks
    .filter((check) => check.required)
    .map((check) => check.id);
}

export async function getModelInstructionCards(): Promise<ModelInstructionCardsState> {
  const { apiGet } = await import("./debug-api");
  return apiGet<ModelInstructionCardsState>(modelInstructionCardsPath());
}
