import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(path, "utf8");
const browserChrome = source("src/browser/components/BrowserChrome.tsx");
const browserMenus = source("src/browser/components/BrowserMenus.tsx");
const browserShields = source("src/browser/components/BrowserShieldsPanel.tsx");
const browserVaultFill = source("src/browser/components/BrowserVaultFillPanel.tsx");
const downloadSidecar = source("src/browser/components/DownloadSidecar.tsx");
const bookmarkSidecar = source("src/browser/components/BookmarkSidecar.tsx");
const historySidecar = source("src/browser/components/BrowserHistorySidecar.tsx");
const agentSidebar = source("src/browser/components/AgentSidebar.tsx");

for (const [controlId, panelId, controlSource, panelSource] of [
  ["shellx-browser-trust-chip", "shellx-browser-shields-panel", browserChrome, browserShields],
  ["shellx-browser-vault-fill-menu", "shellx-browser-vault-fill-panel", browserChrome, browserVaultFill],
  ["shellx-browser-downloads-menu", "shellx-browser-download-sidecar", browserChrome, downloadSidecar],
  ["shellx-browser-bookmarks-menu", "shellx-browser-bookmark-manager-dock", browserChrome, bookmarkSidecar],
  ["shellx-browser-history-menu", "shellx-browser-history-sidecar", browserChrome, historySidecar],
  ["shellx-browser-save-page", "shellx-browser-save-menu", browserChrome, browserMenus],
  ["shellx-browser-ad-filter", "shellx-browser-ad-filter-menu", browserChrome, browserMenus],
  ["shellx-browser-options", "shellx-browser-options-sidecar", browserChrome, browserMenus],
  ["shellx-browser-collapse-tasks", "shellx-browser-actions-tasks-section", agentSidebar, agentSidebar],
  ["shellx-browser-collapse-receipts", "shellx-browser-actions-receipts-section", agentSidebar, agentSidebar],
  ["shellx-browser-collapse-console", "shellx-browser-errors-console-section", agentSidebar, agentSidebar],
] as const) {
  assert(
    controlSource.includes(`id="${controlId}"`) &&
      controlSource.includes(`aria-controls="${panelId}"`) &&
      panelSource.includes(`id="${panelId}"`) &&
      panelSource.includes(`aria-labelledby="${controlId}"`),
    `Browser disclosure ${controlId} must exactly own and label ${panelId}`,
  );
}

console.log("Browser disclosure accessibility contracts passed");
