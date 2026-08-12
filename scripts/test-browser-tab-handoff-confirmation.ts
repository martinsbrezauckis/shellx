import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  browserTabHandoffConfirmation,
  browserTabHandoffRevalidationError,
  browserTabHandoffUrlContext,
  selectBrowserHandoffTask,
} from "../src/browser/hooks/useBrowserTabs";
import type { BrowserProfile, BrowserTab, BrowserTask } from "../src/browser/types";

const tab: BrowserTab = {
  browserTabId: "tab-owned-user",
  engineId: "engine-owned-user",
  profileId: "personal",
  url: "https://operator:private@example.test/orders/418?token=secret-value#fragment",
  status: "loaded",
  active: true,
  privacyMode: "balanced",
  ownerKind: "user",
  createdAtMs: 1,
  updatedAtMs: 1,
};
const task: BrowserTask = {
  taskId: "task-browser-review",
  profileId: "task-disposable",
  ownerActorId: "operator",
  ownerSurface: "browser",
  goal: "Review release candidates",
  status: "running",
  autonomy: "assistedAutonomous",
  createdAtMs: 1,
  updatedAtMs: 1,
};
assert.equal(selectBrowserHandoffTask(task, [task]), task, "the explicit active task remains the handoff target");
assert.equal(
  selectBrowserHandoffTask(null, [task]),
  task,
  "one nonterminal Browser task remains an unambiguous handoff target while a taskless user tab is focused",
);
assert.equal(
  selectBrowserHandoffTask(null, [task, { ...task, taskId: "task-other" }]),
  null,
  "multiple nonterminal Browser tasks require an explicit active target",
);
assert.equal(
  selectBrowserHandoffTask(null, [{ ...task, status: "completed" }]),
  null,
  "terminal Browser tasks are never selected as handoff targets",
);
const profile: BrowserProfile = {
  profileId: "personal",
  label: "Personal",
  description: "Persistent user Browser profile",
  agentDefault: false,
  cookiesEnabled: true,
  persistent: true,
};

const urlContext = browserTabHandoffUrlContext(tab.url);
assert.deepEqual(urlContext, {
  currentOrigin: "https://example.test",
  currentUrlContext: "https://example.test/orders/418",
});
assert(!JSON.stringify(urlContext).includes("private"), "handoff context must not expose URL credentials");
assert(!JSON.stringify(urlContext).includes("secret-value"), "handoff context must not expose query values");
assert(!JSON.stringify(urlContext).includes("fragment"), "handoff context must not expose URL fragments");
const boundedPathContext = browserTabHandoffUrlContext(`https://example.test/${"a".repeat(200)}?token=secret#fragment`);
assert.equal(boundedPathContext.currentOrigin, "https://example.test");
assert(boundedPathContext.currentUrlContext.endsWith("…"), "handoff pathname context must remain bounded");
assert.equal(boundedPathContext.currentUrlContext.length, "https://example.test".length + 160);
assert(!boundedPathContext.currentUrlContext.includes("token="));
assert(!boundedPathContext.currentUrlContext.includes("fragment"));
assert.deepEqual(browserTabHandoffUrlContext("file:///Users/operator/private.txt"), {
  currentOrigin: "file context",
  currentUrlContext: "Local or non-web URL context is withheld",
});

const confirmation = browserTabHandoffConfirmation(tab, task, profile);
assert.equal(confirmation.browserTabId, tab.browserTabId);
assert.equal(confirmation.profileLabel, "Personal");
assert.equal(confirmation.persistenceLabel, "Persistent profile storage");
assert.equal(confirmation.ownerLabel, "User-controlled");
assert.equal(confirmation.taskId, task.taskId);
assert.equal(confirmation.taskLabel, task.goal);
assert.equal(browserTabHandoffRevalidationError(confirmation, tab, task, [tab], [profile]), null);
assert.match(
  browserTabHandoffRevalidationError(confirmation, { ...tab, browserTabId: "tab-other" }, task, [tab], [profile]) ?? "",
  /active Browser tab changed/,
);
assert.match(
  browserTabHandoffRevalidationError(confirmation, tab, { ...task, taskId: "task-other" }, [tab], [profile]) ?? "",
  /active Browser task changed/,
);
assert.match(
  browserTabHandoffRevalidationError(confirmation, tab, task, [{ ...tab, ownerKind: "delegatedToAgent" }], [profile]) ?? "",
  /no longer user-controlled/,
);
assert.match(
  browserTabHandoffRevalidationError(confirmation, tab, task, [{ ...tab, url: "https://example.test/orders/419?leak=no" }], [profile]) ?? "",
  /tab context, profile, persistence, or owner changed/,
  "a pathname change must invalidate the displayed review",
);
assert.match(
  browserTabHandoffRevalidationError(confirmation, tab, task, [tab], [{ ...profile, persistent: false }]) ?? "",
  /tab context, profile, persistence, or owner changed/,
  "a profile persistence change must invalidate the displayed review",
);

const hookSource = readFileSync("src/browser/hooks/useBrowserTabs.ts", "utf8");
const componentSource = readFileSync("src/browser/components/BrowserTabHandoffConfirmation.tsx", "utf8");
const appSource = readFileSync("src/components/ShellxBrowserApp.tsx", "utf8");
const cssSource = readFileSync("src/browser/components/BrowserTabHandoffConfirmation.css", "utf8");
assert(!hookSource.includes("window.confirm"), "Browser handoff must not use a native confirm dialog");
assert(
  (hookSource.match(/isTrustedShellxUserEvent\(event\)/g) ?? []).length === 2,
  "both opening and confirming a handoff must require a trusted direct user event",
);
assert(
  hookSource.includes("browserTabHandoffRevalidationError(") &&
    hookSource.includes("activeBrowserTab,") &&
    hookSource.includes("activeTask,") &&
    hookSource.includes("tabs,"),
  "the exact active tab and task must be revalidated before delegation",
);
assert(hookSource.includes('tone: "pending"') && hookSource.includes('tone: "error"') && hookSource.includes('tone: "success"'));
assert(componentSource.includes('role="alertdialog"') && componentSource.includes('aria-modal="true"'));
assert(componentSource.includes('data-dialog-initial-focus="true"') && componentSource.includes("Cancel"));
assert(componentSource.includes("Vault secrets still require a separate approval"));
assert(componentSource.includes("shellx-browser-handoff-confirm") && componentSource.includes("shellx-browser-handoff-cancel"));
assert(componentSource.includes('data-debug-id="shellx-browser-handoff-context"') && componentSource.includes('data-shellx-release-observe="title"'));
assert(componentSource.includes('data-debug-id="shellx-browser-handoff-vault-notice"') && componentSource.includes('data-debug-id="shellx-browser-handoff-status"'));
assert(componentSource.includes('data-shellx-release-observe="focused disabled"'), "Cancel must expose its initial-focus and busy state to bounded installed proof");
assert(componentSource.includes("handoffContextTitle") && !componentSource.includes("confirmation.currentUrlContext.slice"), "the bounded review receipt must use the already-sanitized URL context");
assert(readFileSync("src/browser/components/BrowserChrome.tsx", "utf8").includes('data-shellx-release-observe="focused"'), "Handoff focus restoration must have a bounded receipt");
assert(appSource.includes("<BrowserTabHandoffConfirmation"), "the Browser app must mount the owned handoff sheet");
assert(appSource.includes("selectBrowserHandoffTask(activeTask, state?.tasks ?? [])"), "a taskless user tab may target one unambiguous active Browser task without inheriting agent action authority");
assert(cssSource.includes(".shellx-browser-handoff-confirmation") && cssSource.includes("var(--shellx-browser-focus-ring)"));

console.log("Browser tab handoff confirmation contracts passed");
