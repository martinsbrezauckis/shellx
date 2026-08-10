import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { apiGet } from "./debug-api";
import { inTauri } from "./tauri-bridge";
import { useEventAwarePolling, type PollCurrent } from "./useEventAwarePolling";
import type {
  BrowserSessionGrantPromptSource,
  BrowserVaultDepositPromptSource,
} from "./vault-approval-prompts";
import type { VaultAgentRequestSource, VaultGrantPromptSource } from "./vault-request-center";

export interface VaultRequestCenterState {
  sessionGrants?: BrowserSessionGrantPromptSource[];
  vaultDeposits?: BrowserVaultDepositPromptSource[];
  vaultGrants?: VaultGrantPromptSource[];
  agentRequests?: VaultAgentRequestSource[];
}

interface VaultAgentRequestSnapshot {
  requests?: VaultAgentRequestSource[];
}

export interface VaultRequestCenterStateController {
  state: VaultRequestCenterState;
  setState: Dispatch<SetStateAction<VaultRequestCenterState>>;
  refresh: () => Promise<void>;
}

const EMPTY_REQUEST_STATE: VaultRequestCenterState = {
  sessionGrants: [],
  vaultDeposits: [],
  vaultGrants: [],
  agentRequests: [],
};

export function mergeVaultRequestCenterGrants(
  nativeGrants: readonly VaultGrantPromptSource[],
  debugGrants: readonly VaultGrantPromptSource[],
): VaultGrantPromptSource[] {
  const byId = new Map<string, VaultGrantPromptSource>();
  for (const grant of nativeGrants) byId.set(grant.grantId, grant);
  for (const grant of debugGrants) {
    if (!byId.has(grant.grantId)) byId.set(grant.grantId, grant);
  }
  return [...byId.values()];
}

export function mergeVaultRequestCenterAgentRequests(
  nativeRequests: readonly VaultAgentRequestSource[],
  debugRequests: readonly VaultAgentRequestSource[],
): VaultAgentRequestSource[] {
  const byId = new Map<string, VaultAgentRequestSource>();
  for (const request of nativeRequests) byId.set(request.requestId, request);
  for (const request of debugRequests) {
    if (!byId.has(request.requestId)) byId.set(request.requestId, request);
  }
  return [...byId.values()];
}

export function browserEventTouchesVaultRequests(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const receipt = (payload as { receipt?: unknown }).receipt;
  if (!receipt || typeof receipt !== "object") return false;
  const kind = (receipt as { kind?: unknown }).kind;
  return typeof kind === "string" && (
    kind.startsWith("browserSessionGrant") || kind === "browserVaultDepositCreated"
  );
}

export function useVaultRequestCenterState(): VaultRequestCenterStateController {
  const [state, setState] = useState<VaultRequestCenterState>(EMPTY_REQUEST_STATE);
  const [eventRevision, setEventRevision] = useState(0);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const enabled = inTauri() && visible;

  useEffect(() => {
    const onVisibilityChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!inTauri()) return;
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const bump = () => setEventRevision((revision) => revision + 1);
    const register = <T,>(event: string, onEvent: (payload: T) => void) => {
      void listen<T>(event, ({ payload }) => onEvent(payload))
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch(() => {});
    };
    register<unknown>("browser-event", (payload) => {
      if (browserEventTouchesVaultRequests(payload)) bump();
    });
    register<unknown>("shellx:vault-status-invalidated", bump);
    window.addEventListener("shellx:vault-status-changed", bump);
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
      window.removeEventListener("shellx:vault-status-changed", bump);
    };
  }, []);

  const poll = useCallback(async (isCurrent: PollCurrent): Promise<void> => {
    const readDebugVaultGrants = async (): Promise<VaultGrantPromptSource[]> => {
      try {
        const response = await apiGet<{ grants?: VaultGrantPromptSource[] }>("/vault/grants");
        return response.grants ?? [];
      } catch {
        return [];
      }
    };
    const readDebugVaultAgentRequests = async (): Promise<VaultAgentRequestSource[]> => {
      try {
        const response = await apiGet<VaultAgentRequestSnapshot>("/vault/agent-requests");
        return response.requests ?? [];
      } catch {
        return [];
      }
    };
    try {
      const [
        next,
        nativeVaultGrants,
        debugVaultGrants,
        nativeAgentRequests,
        debugAgentRequests,
      ] = await Promise.all([
        invoke<VaultRequestCenterState>("shellx_browser_state"),
        invoke<VaultGrantPromptSource[]>("shellx_vault_list_grants")
          .catch(() => [] as VaultGrantPromptSource[]),
        readDebugVaultGrants(),
        invoke<VaultAgentRequestSnapshot>("shellx_vault_agent_request_center")
          .catch(() => ({ requests: [] } as VaultAgentRequestSnapshot)),
        readDebugVaultAgentRequests(),
      ]);
      if (!isCurrent()) return;
      setState({
        sessionGrants: next.sessionGrants ?? [],
        vaultDeposits: next.vaultDeposits ?? [],
        vaultGrants: mergeVaultRequestCenterGrants(nativeVaultGrants, debugVaultGrants),
        agentRequests: mergeVaultRequestCenterAgentRequests(
          nativeAgentRequests.requests ?? [],
          debugAgentRequests,
        ),
      });
      return;
    } catch {
      // Older/dev builds may not have the native command. Fall back to the
      // local Debug API when it is enabled.
    }
    try {
      const [next, debugVaultGrants, debugAgentRequests] = await Promise.all([
        apiGet<VaultRequestCenterState>("/browser/state"),
        readDebugVaultGrants(),
        readDebugVaultAgentRequests(),
      ]);
      if (!isCurrent()) return;
      setState({
        sessionGrants: next.sessionGrants ?? [],
        vaultDeposits: next.vaultDeposits ?? [],
        vaultGrants: debugVaultGrants,
        agentRequests: debugAgentRequests,
      });
    } catch {
      // Browser may not be running yet; keep the last known summary.
    }
  }, []);

  const refresh = useEventAwarePolling({
    enabled,
    scopeKey: "global-vault-request-center",
    eventRevision,
    intervalMs: 10_000,
    poll,
  });

  return { state, setState, refresh };
}
