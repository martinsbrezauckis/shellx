import { apiGet, apiPostJson } from "./debug-api";
import {
  agentRunsStatePath,
  providerAbortRequestBody,
  providerAdaptersStatePath,
  providerSessionStatePath,
  providerSessionsAbortPath,
  providerSessionsStartPath,
  providerStartRequestBody,
  type AgentRunManagerState,
  type ProviderAdapterStateRequest,
  type ProviderAdapterState,
  type ProviderSessionAbortResponse,
  type ProviderSessionStartRequest,
  type ProviderSessionStartResponse,
  type ProviderSessionState,
  type ProviderSessionStateRequest,
} from "./provider-sessions";

export function getProviderAdapterState(
  request: ProviderAdapterStateRequest = {},
): Promise<ProviderAdapterState> {
  return apiGet<ProviderAdapterState>(providerAdaptersStatePath(request));
}

export function getAgentRunsState(tabId?: string | null): Promise<AgentRunManagerState> {
  return apiGet<AgentRunManagerState>(agentRunsStatePath(tabId));
}

export function getProviderSessionState(
  tabId: string,
  request: ProviderSessionStateRequest = {},
): Promise<ProviderSessionState> {
  return apiGet<ProviderSessionState>(providerSessionStatePath(tabId, request));
}

export function startProviderSession(
  request: ProviderSessionStartRequest,
): Promise<ProviderSessionStartResponse> {
  return apiPostJson<ProviderSessionStartResponse>(
    providerSessionsStartPath(),
    providerStartRequestBody(request),
  );
}

export function abortProviderSession(
  tabId: string,
  runId?: string,
  request: ProviderSessionStateRequest = {},
): Promise<ProviderSessionAbortResponse> {
  return apiPostJson<ProviderSessionAbortResponse>(
    providerSessionsAbortPath(),
    providerAbortRequestBody(tabId, runId, request),
  );
}
