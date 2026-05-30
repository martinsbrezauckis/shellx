import { titleOverrideForClosingTab } from "../src/lib/session-titles";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
  console.log(`  ✓ ${message}`);
}

console.log("\n=== session title persistence ===");

const override = titleOverrideForClosingTab(
  {
    sessionId: "019e-old",
    title: "Improve ShellX",
    titleLocked: true,
  },
  {},
);

assert(override?.sessionId === "019e-old", "locked renamed tab returns its session id");
assert(override?.title === "Improve ShellX", "locked renamed tab returns its user title");

assert(
  titleOverrideForClosingTab(
    {
      sessionId: "019e-old",
      title: "Improve ShellX",
      titleLocked: false,
    },
    {},
  ) === null,
  "unlocked automatic titles are not persisted as user overrides",
);

assert(
  titleOverrideForClosingTab(
    {
      sessionId: null,
      title: "Unsaved rename",
      titleLocked: true,
    },
    {},
  ) === null,
  "tabs without a session id cannot write a session title override",
);

assert(
  titleOverrideForClosingTab(
    {
      sessionId: "019e-old",
      title: "Improve ShellX",
      titleLocked: true,
    },
    { "019e-old": "Improve ShellX" },
  ) === null,
  "already-persisted title overrides are not rewritten",
);

console.log("\nPASS session title persistence tests");
