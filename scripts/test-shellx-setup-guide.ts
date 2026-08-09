import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { readRustModuleFamily } from "./read-rust-module-family";

const app = readFileSync("src/App.tsx", "utf8");
const guide = readFileSync("src/components/ShellxSetupGuide.tsx", "utf8");
const css = readFileSync("src/App.css", "utf8");
const vaultUi = readFileSync("src/lib/vault-ui.ts", "utf8");
const vaultTab = readFileSync("src/components/settings/VaultTab.tsx", "utf8");
const debugApi = readRustModuleFamily("src-tauri/src/debug_api.rs");
const surfaceEvidence = readFileSync("scripts/test-shellx-visible-surface-walkthrough.ts", "utf8");
const highlightOverlay = readFileSync("src/components/DebugHighlightOverlay.tsx", "utf8");
const apiDocs = readFileSync("docs/public/API.md", "utf8");
const packageJson = readFileSync("package.json", "utf8");
const testSuiteManifest = readFileSync("scripts/test-suite-manifest.mjs", "utf8");
const installedProof = readFileSync("scripts/test-shellx-setup-guide-installed.ts", "utf8");

assert.ok(
  app.includes("ShellxSetupGuide") &&
    app.includes("onOpenSettingsTab={openSettingsTab}") &&
    app.includes("requestCount={vaultRequestItems.length}") &&
    app.includes('agentsConfigured={activeAgentProviderScan.some((provider) => providerScanStatus(provider) === "ready")}') &&
    app.includes("onOpenBrowser={handleOpenShellxBrowser}") &&
    app.includes("onOpenRequests={() => setVaultRequestCenterOpenSeq") &&
    app.includes("onOpenVault={openVaultPanel}"),
  "App must mount the setup guide with existing Vault, Browser, Requests, and Settings surfaces",
);

assert.ok(
  guide.includes('data-debug-id="shellx-setup-guide"') &&
    guide.includes('data-debug-id={`shellx-setup-step-${step.id}`}') &&
    guide.includes('data-debug-id="shellx-setup-guide-dismiss"'),
  "Setup guide must expose stable debug ids for the routine visible-surface walkthrough",
);

for (const step of ["vault", "browser", "downloads", "agents", "requests"]) {
  assert.ok(
    guide.includes(`id: "${step}"`),
    `Setup guide must include ${step} step`,
  );
}

assert.ok(
  guide.includes("shellX.setupGuide.dismissed.v1") &&
    guide.includes("localStorage.setItem(SETUP_GUIDE_DISMISSED_KEY") &&
    guide.includes("readSetupGuideDismissed"),
  "Setup guide dismissal must persist locally without backend state",
);

assert.ok(
  app.includes("setupGuideDismissed") &&
    debugApi.includes("setupGuideDismissed") &&
    apiDocs.includes("setupGuideDismissed?"),
  "Debug UI state must expose setupGuideDismissed so release evidence can reset the guide",
);

assert.ok(
  vaultUi.includes('"setup"') &&
    vaultTab.includes('intent === "setup"') &&
    vaultTab.includes('setWorkspaceTab("setup")'),
  "Vault panel must support direct setup routing for first-run guidance",
);

assert.ok(
  guide.includes('onOpenVault(vaultReady ? "overview" : "setup")') &&
    guide.includes("agentsConfigured ? \"Ready\" : \"Check setup\"") &&
    guide.includes("onClick: onOpenRequests") &&
    guide.includes('onOpenSettingsTab("general")') &&
    guide.includes('onOpenSettingsTab("shellxagent")'),
  "Setup guide actions must route to exact existing surfaces",
);

assert.ok(
  css.includes(".shellx-setup-guide") &&
    css.includes(".shellx-setup-step.ready") &&
    css.includes(".shellx-setup-step.todo") &&
    css.includes("grid-template-columns: repeat(5, minmax(0, 1fr))") &&
    css.includes("@media (max-width: 1199px)") &&
    !css.includes(".shellx-setup-step small {\n  overflow: hidden"),
  "Setup guide must preserve ordinary labels and use a deliberate compact desktop layout",
);

assert.ok(
  highlightOverlay.includes("contentClipped") &&
    highlightOverlay.includes("element.scrollWidth > element.clientWidth") &&
    highlightOverlay.includes("viewportWidth: window.innerWidth") &&
    apiDocs.includes("contentClipped") &&
    apiDocs.includes("viewportWidth"),
  "debug highlight evidence must report content clipping and exact renderer viewport dimensions",
);

assert.ok(
  surfaceEvidence.includes("shellx-setup-guide") &&
    surfaceEvidence.includes("shellx-setup-step-vault") &&
    surfaceEvidence.includes("setupGuideDismissed: false") &&
    surfaceEvidence.includes("focusMainShellxWindow") &&
    surfaceEvidence.includes("debugActionResults: []") &&
    surfaceEvidence.includes("SHELLX_VISIBLE_SURFACE_CLICK_TIMEOUT_MS"),
  "Visible-surface walkthrough must reset and click through the setup guide",
);

assert.ok(
  testSuiteManifest.includes('["tsx","scripts/test-shellx-setup-guide.ts"]'),
  "canonical test-suite manifest must include setup guide contract",
);

assert.ok(
  packageJson.includes('"test:shellx-setup-guide-installed"') &&
    installedProof.includes("1024") &&
    installedProof.includes("1280") &&
    installedProof.includes("1440") &&
    installedProof.includes("contentClipped") &&
    installedProof.includes("readyAndTodoVisible") &&
    installedProof.includes("validateHarnessState"),
  "package must expose artifact-bound Setup Guide screenshot and clipping assertions",
);

console.log("ShellX setup guide contract passed");
