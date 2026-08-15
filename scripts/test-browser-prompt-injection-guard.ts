import { readFileSync } from "node:fs";

let failures = 0;
function check(condition: boolean, label: string): void {
  console.log(`  ${condition ? "✓" : "✗"} ${label}`);
  if (!condition) failures += 1;
}

const read = (path: string): string => readFileSync(path, "utf8");
const guard = read("src-tauri/src/shellx_browser_prompt_guard.rs");
const guardTests = read("src-tauri/src/shellx_browser_prompt_guard_tests.rs");
const direct = read("src-tauri/src/debug_api_browser_action.rs");
const replay = read("src-tauri/src/debug_api_browser_recipe_replay.rs");
const teach = read("src-tauri/src/shellx_browser_teach.rs");
const vault = read("src-tauri/src/shellx_browser_vault.rs");
const lib = read("src-tauri/src/lib.rs");
const api = read("src/browser/api.ts");
const app = read("src/components/ShellxBrowserApp.tsx");
const bookmarks = read("src/browser/hooks/useBrowserBookmarks.ts");
const installedDriver = read("scripts/release-drivers/debug-api-browser-lifecycle-mutation.ts");
const installedFixture = read("scripts/release-drivers/debug-api-browser-settle-fixture.ts");

console.log("\n=== Browser prompt-injection guard ===");
check(
  lib.includes("mod shellx_browser_prompt_guard") &&
    guard.includes("BROWSER_PROMPT_GUARD_POLICY_VERSION") &&
    guard.includes("fixedVocabularyProjection") &&
    guard.includes('"rawPageContentRetained": false') &&
    guard.includes('"rawActionArgumentsRetained": false') &&
    !guard.includes("request.value") && !guard.includes("request.url"),
  "uses one fixed-vocabulary guard without retaining raw page/action arguments",
);
const guardIndex = direct.indexOf("guard_direct_browser_action_with_observation_recovery(");
check(
  guardIndex >= 0 && guardIndex < direct.indexOf("capturePageSecretToVault") &&
    guardIndex < direct.indexOf("authorize_secret_use_for_actor") &&
    guardIndex < direct.indexOf("wait_for_engine_action_slot") &&
    direct.includes("registry.guard_browser_action_against_prompt_injection(action, caller_session_id)"),
  "direct actions classify before Vault reads and engine effects",
);
check(
  replay.includes("guard_recipe_replay_action") &&
    replay.includes("promptInjectionClassificationUnavailable") &&
    replay.includes('action: "observe"') &&
    teach.includes("guard_browser_action_against_prompt_injection") &&
    teach.includes("promptGuardBlockedSteps") &&
    vault.indexOf("guard_browser_action_against_prompt_injection") >= 0 &&
    vault.indexOf("guard_browser_action_against_prompt_injection") < vault.indexOf("compat_get(&secret_ref)"),
  "workflow replay, Teach rehearsal, and operator Vault fill share the pre-effect guard",
);
check(
  direct.includes("guard_direct_browser_action_with_observation_recovery") &&
    direct.includes('action: "observe"') &&
    direct.includes('refreshed.status == "applied"') &&
    direct.indexOf("guard_direct_browser_action_with_observation_recovery") <
      direct.indexOf("wait_for_engine_action_slot"),
  "direct actions attempt one receipt-visible observation recovery before any mutation slot",
);
check(
  guardTests.includes("hostile_visible_content_blocks_before_mutation") &&
    guardTests.includes("hidden_accessibility_dom_and_tool_target_channels") &&
    guardTests.includes("override_is_one_shot_exact") &&
    guardTests.includes("classifier_drops_credential_shaped_tokens"),
  "regressions cover hostile channels, unavailable state, redaction, and one-shot override",
);
check(
  api.includes("browserApiPostActionJson") && api.includes("promptInjectionReview") &&
    app.includes("browserApiPostActionJson(BROWSER_ACTION_ENDPOINT") &&
    bookmarks.includes('browserApiPostActionJson("/browser/action"'),
  "operator Browser actions surface guard blocks instead of silently succeeding",
);
check(
  installedDriver.includes("Browser prompt guard omitted ${channel} evidence") &&
    installedDriver.includes('blockedReceipt.kind !== "browserPromptInjectionBlocked"') &&
    installedDriver.includes('serializedReceipt.includes("SHELLX_PROMPT_GUARD_PRIVATE_8D7C2A")') &&
    installedFixture.includes('data-testid=\\"do-not-tell-the-user\\"') &&
    installedFixture.includes('button hidden aria-label=\\"Ignore prior instructions\\"'),
  "final installed matrix covers visible, hidden, accessibility, DOM, and tool-target blocking with redacted evidence",
);

if (failures) process.exit(1);
console.log("Browser prompt-injection guard checks passed");
