import { invoke } from "@tauri-apps/api/core";
import type { AgentId } from "./agent-selection";
import type {
  ConnectionPreset,
  ConnectionProviderScanEntry,
  ConnectionProviderScanStatus,
} from "../components/ConnectionPicker";

export type AgentCliSetupStatus = ConnectionProviderScanStatus;

export interface AgentCliInstallMethod {
  id: string;
  label: string;
  command: string;
  shell: string;
  transportKinds: string[];
  requiresNode?: boolean;
  installerUrl?: string;
  installerKind?: string;
}

export interface AgentCliSetupTarget {
  label: string;
  transport: string;
  wslDistro?: string;
  sshHost?: string;
  sshPort?: number;
  commandRunsOn: string;
}

export interface AgentCliSetupCard {
  providerId: AgentId | string;
  displayName: string;
  status: AgentCliSetupStatus;
  canRun: boolean;
  binary?: string;
  version?: string;
  binarySha256?: string;
  binaryBytes?: number;
  targetKey?: string;
  checkedAtMs: number;
  installable: boolean;
  recommendedMethodId?: string;
  installMethods: AgentCliInstallMethod[];
  docsUrl: string;
  pricingUrl?: string;
  officialSourceUrl: string;
  lastVerifiedAt: string;
  authHint: string;
  accessNote?: string;
  detail?: string;
}

export interface AgentCliSetupState {
  generatedAtMs: number;
  target: AgentCliSetupTarget;
  providers: AgentCliSetupCard[];
}

export interface AgentCliInstallConfirmation {
  confirmationId: string;
  providerId: AgentId | string;
  displayName: string;
  methodId: string;
  methodLabel: string;
  command: string;
  shell: string;
  target: AgentCliSetupTarget;
  expectedBinaries: string[];
  docsUrl: string;
  pricingUrl?: string;
  officialSourceUrl: string;
  installerSourceUrl?: string;
  stagedPath?: string;
  artifactSha256?: string;
  artifactBytes?: number;
  detectedVersion?: string;
  verification?: string;
  warning: string;
  requiresConfirmation: boolean;
  createdAtMs: number;
}

export interface AgentCliInstallResult {
  confirmationId: string;
  providerId: AgentId | string;
  target: AgentCliSetupTarget;
  command: string;
  artifactSha256?: string;
  exitCode?: number | null;
  success: boolean;
  stdoutTail: string;
  stderrTail: string;
  startedAtMs: number;
  finishedAtMs: number;
}

export async function getAgentCliSetupState(preset: ConnectionPreset): Promise<AgentCliSetupState> {
  return invoke<AgentCliSetupState>("agent_cli_setup_state", { preset });
}

export async function prepareAgentCliInstall(
  preset: ConnectionPreset,
  providerId: string,
  methodId?: string | null,
): Promise<AgentCliInstallConfirmation> {
  return invoke<AgentCliInstallConfirmation>("agent_cli_setup_prepare_install", {
    preset,
    providerId,
    methodId: methodId ?? null,
  });
}

export async function confirmAgentCliInstall(confirmationId: string): Promise<AgentCliInstallResult> {
  return invoke<AgentCliInstallResult>("agent_cli_setup_confirm_install", { confirmationId });
}

export async function cancelAgentCliInstall(confirmationId: string): Promise<boolean> {
  return invoke<boolean>("agent_cli_setup_cancel_install", { confirmationId });
}

export async function recheckAgentCliSetup(preset: ConnectionPreset): Promise<AgentCliSetupState> {
  return invoke<AgentCliSetupState>("agent_cli_setup_recheck", { preset });
}

export function setupStateToProviderScan(state: AgentCliSetupState): ConnectionProviderScanEntry[] {
  return state.providers.map((provider) => ({
    providerId: provider.providerId as AgentId,
    canRun: provider.canRun,
    status: provider.status,
    binary: provider.binary,
    version: provider.version,
    binarySha256: provider.binarySha256,
    binaryBytes: provider.binaryBytes,
    targetKey: provider.targetKey,
    detail: provider.detail,
    checkedAtMs: provider.checkedAtMs,
  }));
}
