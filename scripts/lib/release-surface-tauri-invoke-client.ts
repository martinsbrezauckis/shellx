type ReleaseTauriInvokeConnection = { base: string; token: string };

type InvokeRecord = {
  id?: unknown;
  status?: unknown;
  value?: unknown;
  error?: unknown;
};

const INVOKE_ID = /^rti-[0-9a-f]{32}$/;

export class ReleaseSurfaceTauriInvokeSession {
  readonly #connection: ReleaseTauriInvokeConnection;
  readonly #activeIds = new Set<string>();

  constructor(connection: ReleaseTauriInvokeConnection) {
    this.#connection = connection;
  }

  async invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    const id = await this.#start(command, args);
    try {
      return await this.#waitForCompletion(id, command);
    } finally {
      await this.#remove(id);
    }
  }

  async invokeExpectFailure(command: string, args: Record<string, unknown>): Promise<string> {
    const id = await this.#start(command, args);
    try {
      return await this.#waitForFailure(id, command);
    } finally {
      await this.#remove(id);
    }
  }

  async cleanup(): Promise<void> {
    const errors: string[] = [];
    for (const id of [...this.#activeIds]) {
      try {
        await this.#remove(id);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (errors.length > 0) throw new Error(errors.join("; "));
  }

  async #waitForCompletion(id: string, command: string): Promise<unknown> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const response = await requestJson(
        this.#connection,
        "GET",
        `/release-test/tauri-invokes/${encodeURIComponent(id)}`,
      );
      if (response.status !== 200 || response.body.id !== id) {
        throw new Error(`release Tauri invoke ${command} returned a mismatched poll receipt`);
      }
      if (response.body.status === "passed") return response.body.value;
      if (response.body.status === "failed") {
        throw new Error(typeof response.body.error === "string"
          ? response.body.error
          : `release Tauri invoke ${command} failed without a bounded error`);
      }
      if (response.body.status !== "pending" && response.body.status !== "claimed") {
        throw new Error(`release Tauri invoke ${command} returned an unsupported status`);
      }
      await delay(50);
    }
    throw new Error(`release Tauri invoke ${command} exceeded its bounded completion deadline`);
  }

  async #waitForFailure(id: string, command: string): Promise<string> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const response = await requestJson(
        this.#connection,
        "GET",
        `/release-test/tauri-invokes/${encodeURIComponent(id)}`,
      );
      if (response.status !== 200 || response.body.id !== id) {
        throw new Error(`release Tauri invoke ${command} returned a mismatched failure receipt`);
      }
      if (response.body.status === "failed") {
        if (typeof response.body.error !== "string" || !response.body.error.trim()) {
          throw new Error(`release Tauri invoke ${command} failed without a bounded error`);
        }
        return response.body.error;
      }
      if (response.body.status === "passed") {
        throw new Error(`release Tauri invoke ${command} unexpectedly passed`);
      }
      if (response.body.status !== "pending" && response.body.status !== "claimed") {
        throw new Error(`release Tauri invoke ${command} returned an unsupported status`);
      }
      await delay(50);
    }
    throw new Error(`release Tauri invoke ${command} exceeded its bounded failure deadline`);
  }

  async #start(command: string, args: Record<string, unknown>): Promise<string> {
    const started = await requestJson(this.#connection, "POST", "/release-test/tauri-invokes", {
      command,
      args,
    });
    const id = typeof started.body.id === "string" ? started.body.id : "";
    if (started.status !== 202 || started.body.status !== "pending" || !INVOKE_ID.test(id)) {
      throw new Error(`release Tauri invoke ${command} did not return an exact pending identity`);
    }
    this.#activeIds.add(id);
    return id;
  }

  async #remove(id: string): Promise<void> {
    const response = await requestJson(
      this.#connection,
      "DELETE",
      `/release-test/tauri-invokes/${encodeURIComponent(id)}`,
    );
    if (response.status !== 200 || response.body.removed !== true) {
      throw new Error(`release Tauri invoke ${id} was not removed exactly`);
    }
    this.#activeIds.delete(id);
  }
}

async function requestJson(
  connection: ReleaseTauriInvokeConnection,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: InvokeRecord & Record<string, unknown> }> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${method} ${path} returned non-JSON status ${response.status}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${method} ${path} returned a non-object receipt`);
  }
  return { status: response.status, body: parsed as InvokeRecord & Record<string, unknown> };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
