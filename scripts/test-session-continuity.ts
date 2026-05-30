import {
  buildReconnectContinuityPrompt,
  loadSessionIdForReconnect,
  reconnectContinuityUiText,
  shouldAddReconnectContinuityNote,
} from "../src/lib/session-continuity";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
  console.log(`  ✓ ${message}`);
}

console.log("\n=== session reconnect continuity ===");

assert(
  shouldAddReconnectContinuityNote({
    status: "Idle",
    sessionId: "019e-old",
  }),
  "disconnected tab with an existing session gets a reconnect continuity note",
);

assert(
  loadSessionIdForReconnect({
    status: "Idle",
    sessionId: "019e-old",
  }) === "019e-old",
  "disconnected tab with an existing session loads the same Grok session id",
);

assert(
  !shouldAddReconnectContinuityNote({
    status: "Idle",
    sessionId: null,
  }),
  "never-connected idle tab does not get a reconnect continuity note",
);

assert(
  !shouldAddReconnectContinuityNote({
    status: "Connected",
    sessionId: "019e-live",
  }),
  "connected tab does not get a reconnect continuity note",
);

const prompt = buildReconnectContinuityPrompt("show me how you work with paint", {
  priorSessionId: "019e-old",
  cwd: "C:\\Users\\User",
});

assert(prompt.includes("019e-old"), "continuity prompt names the prior session id");
assert(prompt.includes("previous Grok process ended"), "continuity prompt explains the reconnect");
assert(
  prompt.includes("ask a clarifying question"),
  "continuity prompt tells Grok to clarify ambiguous continuation prompts",
);
assert(
  prompt.includes("Microsoft Paint"),
  "continuity prompt treats Paint as a Windows app before image generation",
);
assert(
  prompt.endsWith("show me how you work with paint"),
  "continuity prompt preserves the exact user prompt at the end",
);

const uiText = reconnectContinuityUiText("019e-old");
assert(uiText.includes("loading previous Grok session"), "UI note says the previous Grok session is loading");
assert(uiText.includes("019e-old"), "UI note includes the prior session id");

console.log("\nPASS session reconnect continuity tests");
