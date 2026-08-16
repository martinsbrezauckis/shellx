import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { adoptRotatedDebugToken, apiPostJson } from "./debug-api";

export const RELEASE_TAURI_INVOKE_EVENT = "release-test-tauri-invoke";

type RelayEvent = {
  id?: unknown;
  nonce?: unknown;
};

type ClaimedInvoke = {
  id: string;
  command: string;
  args: Record<string, unknown>;
};

type RelayDependencies = {
  invokeCommand: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  postJson: <T = unknown>(path: string, body: unknown) => Promise<T>;
  adoptRotatedToken: (token: string) => void;
};

const DEFAULT_DEPENDENCIES: RelayDependencies = {
  invokeCommand: (command, args) => invoke(command, args),
  postJson: apiPostJson,
  adoptRotatedToken: adoptRotatedDebugToken,
};

/**
 * Claim and execute one backend-authorized release-test invoke. The event
 * contains no command or args; the renderer must prove possession of the
 * per-invoke nonce before the authenticated backend returns either value.
 */
export async function handleReleaseTauriInvokeEvent(
  payload: RelayEvent,
  dependencies: RelayDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  if (typeof payload.id !== "string" || !/^rti-[0-9a-f]{32}$/.test(payload.id)) return;
  if (typeof payload.nonce !== "string" || !/^[0-9a-f]{32}$/.test(payload.nonce)) return;

  const id = payload.id;
  const nonce = payload.nonce;
  let claimed: ClaimedInvoke;
  try {
    claimed = await dependencies.postJson<ClaimedInvoke>(
      `/release-test/tauri-invokes/${id}/claim`,
      { nonce },
    );
  } catch {
    return;
  }
  if (claimed.id !== id || typeof claimed.command !== "string" || !isPlainRecord(claimed.args)) {
    await completeFailure(dependencies, id, nonce, "release relay returned an invalid claim");
    return;
  }

  try {
    const value = await dependencies.invokeCommand(claimed.command, claimed.args);
    if (claimed.command === "shellxagent_token_regenerate") {
      if (typeof value !== "string") throw new Error("token rotation returned an invalid value");
      dependencies.adoptRotatedToken(value);
    }
    try {
      await dependencies.postJson(`/release-test/tauri-invokes/${id}/complete`, {
        nonce,
        status: "passed",
        value,
      });
    } catch (error) {
      await completeFailure(dependencies, id, nonce, errorMessage(error));
    }
  } catch (error) {
    await completeFailure(dependencies, id, nonce, errorMessage(error));
  }
}

export function startReleaseTauriInvokeRelay(): Promise<UnlistenFn> {
  return listen<RelayEvent>(RELEASE_TAURI_INVOKE_EVENT, (event) => {
    void handleReleaseTauriInvokeEvent(event.payload);
  });
}

async function completeFailure(
  dependencies: RelayDependencies,
  id: string,
  nonce: string,
  message: string,
): Promise<void> {
  try {
    await dependencies.postJson(`/release-test/tauri-invokes/${id}/complete`, {
      nonce,
      status: "failed",
      error: message.slice(0, 2_000),
    });
  } catch {
    // The controller's bounded poll deadline reports an unreachable or
    // expired relay; never echo command results into the normal event ring.
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Tauri invoke failed";
}
