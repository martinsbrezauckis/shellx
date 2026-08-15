#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const content = JSON.parse(readFileSync(join(repoRoot, "docs/public/manual/shellx/content.json"), "utf8"));
const visuals = JSON.parse(readFileSync(join(repoRoot, "docs/public/manual/shellx/visuals.json"), "utf8"));
const generatedHtml = readFileSync(join(repoRoot, "docs/public/manual/shellx/index.html"), "utf8");
const manualCss = readFileSync(join(repoRoot, "docs/public/manual/shellx/manual.css"), "utf8");
const manualJs = readFileSync(join(repoRoot, "docs/public/manual/shellx/manual.js"), "utf8");
const sourceCache = new Map();

function source(path) {
  if (!sourceCache.has(path)) sourceCache.set(path, readFileSync(join(repoRoot, path), "utf8"));
  return sourceCache.get(path);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(manualJs.includes("function parseInterfaceMapData"), "manual map JSON must fail closed when deployed data is malformed");
assert(manualJs.includes("/^assets\\/[A-Za-z0-9][A-Za-z0-9._-]*\\.png$/"), "manual capture links must stay under the local PNG atlas");
assert(manualJs.includes("Object.hasOwn(interfaceMapData, featureId)"), "manual feature lookup must reject inherited object keys");
assert(!/\.href\s*=/.test(manualJs), "manual runtime must not assign unvalidated href properties");

// Each persistent menu/tab/action documented in the interface and Tasks
// reference sections is bound to a stable marker in the shipping renderer.
// This makes a deleted or renamed product surface fail docs checks instead of
// leaving a plausible but stale manual entry behind.
const coverage = {
  "shellx.interface.header.about": ["src/components/Header.tsx", "About shellX — version and source"],
  "shellx.interface.header.find": ["src/components/FindPopover.tsx", "find-sessions-input"],
  "shellx.interface.header.browser": ["src/components/Header.tsx", "header-shellx-browser"],
  "shellx.interface.header.requests": ["src/components/HeaderVaultRequestCenter.tsx", "header-vault-request-center"],
  "shellx.interface.header.inbox": ["src/components/Header.tsx", "Open connector inbox"],
  "shellx.interface.header.plugins": ["src/components/Header.tsx", "Open plugins"],
  "shellx.interface.header.theme": ["src/components/Header.tsx", "header-theme-toggle"],
  "shellx.interface.header.settings": ["src/components/Header.tsx", "Open settings"],
  "shellx.interface.left.projects": ["src/components/LeftRail.tsx", "left-add-project"],
  "shellx.interface.left.open_chats": ["src/components/LeftRail.tsx", "Open chats ·"],
  "shellx.interface.left.past_chats": ["src/components/LeftRail.tsx", "left-past-chats-toggle"],
  "shellx.interface.right.tasks": ["src/components/RightRail.tsx", "label: \"Tasks\""],
  "shellx.interface.right.tools": ["src/components/RightRail.tsx", "label: \"Tools\""],
  "shellx.interface.right.git": ["src/components/RightRail.tsx", "label: \"Git\""],
  "shellx.interface.right.preview": ["src/components/RightRail.tsx", "label: \"Preview\""],
  "shellx.interface.right.plan": ["src/components/RightRail.tsx", "label: \"Plan\""],
  "shellx.interface.right.files": ["src/components/RightRail.tsx", "label: \"Files\""],
  "shellx.interface.bottom.chat": ["src/components/BottomPanel.tsx", "bottom-tab-chat"],
  "shellx.interface.bottom.terminal": ["src/components/BottomPanel.tsx", "bottom-tab-terminal"],
  "shellx.interface.bottom.trace": ["src/components/BottomPanel.tsx", "bottom-action-trace"],
  "shellx.interface.trace.files": ["src/components/ActivityBrowserModal.tsx", "activity-tab-files"],
  "shellx.interface.trace.graph": ["src/components/ActivityBrowserModal.tsx", "activity-tab-graph"],
  "shellx.interface.trace.evidence": ["src/components/ActivityBrowserModal.tsx", "activity-tab-evidence"],
  "shellx.interface.trace.timeline": ["src/components/ActivityBrowserModal.tsx", "activity-tab-timeline"],
  "shellx.interface.trace.summary": ["src/components/ActivityBrowserModal.tsx", "activity-tab-summary"],
  "shellx.interface.bottom.assets": ["src/components/BottomPanel.tsx", "bottom-action-assets"],
  "shellx.interface.bottom.images": ["src/components/BottomPanel.tsx", "bottom-tab-images"],
  "shellx.interface.bottom.videos": ["src/components/BottomPanel.tsx", "bottom-tab-videos"],
  "shellx.interface.bottom.logs": ["src/components/BottomPanel.tsx", "bottom-tab-logs"],
  "shellx.interface.bottom.stderr": ["src/components/BottomPanel.tsx", "bottom-tab-stderr"],
  "shellx.interface.composer.connection": ["src/components/BottomPanel.tsx", "composer-connection"],
  "shellx.interface.composer.agent": ["src/components/BottomPanel.tsx", "composer-agent"],
  "shellx.interface.composer.folder": ["src/components/BottomPanel.tsx", "composer-folder"],
  "shellx.interface.composer.branch": ["src/components/BottomPanel.tsx", "composer-branch"],
  "shellx.interface.command.connect": ["src/App.tsx", 'id: "act-connect"'],
  "shellx.interface.command.abort": ["src/App.tsx", 'id: "act-abort"'],
  "shellx.interface.command.new_session": ["src/App.tsx", 'id: "act-new"'],
  "shellx.interface.command.close_tab": ["src/App.tsx", 'id: "act-close"'],
  "shellx.interface.command.settings": ["src/App.tsx", 'id: "act-settings"'],
  "shellx.interface.command.desktop": ["src/App.tsx", 'id: "act-desktop-integrations"'],
  "shellx.interface.command.attach": ["src/App.tsx", 'id: "act-attach"'],
  "shellx.interface.command.screenshot": ["src/App.tsx", 'id: "act-attach-screenshot"'],
  "shellx.interface.command.media_board": ["src/App.tsx", 'id: "act-asset-board"'],
  "shellx.interface.command.work_preview": ["src/App.tsx", 'id: "act-open-work-preview"'],
  "shellx.interface.command.preview_doctor": ["src/App.tsx", 'id: "act-preview-doctor"'],
  "shellx.interface.command.toggle_terminal": ["src/App.tsx", 'id: "act-toggle-term"'],
  "shellx.interface.command.pull_request": ["src/App.tsx", 'id: "act-pr"'],
  "shellx.interface.command.vault": ["src/App.tsx", 'id: "act-vault"'],
  "shellx.interface.command.help": ["src/App.tsx", 'id: "act-help"'],
  "shellx.interface.command.autonomy_auto": ["src/App.tsx", 'id: "act-auto-auto"'],
  "shellx.interface.command.slash_commands": ["src/components/CommandPalette.tsx", "skills.map"],
  "shellx.interface.composer.attach": ["src/components/BottomPanel.tsx", "composer-attach"],
  "shellx.interface.composer.screenshot": ["src/components/BottomPanel.tsx", "composer-screenshot"],
  "shellx.interface.composer.voice": ["src/components/BottomPanel.tsx", "composer-talk", "composer-voice-chat"],
  "shellx.interface.composer.help": ["src/components/BottomPanel.tsx", "aria-label=\"Keyboard shortcuts\""],
  "shellx.interface.composer.send": ["src/components/BottomPanel.tsx", "composer-send"],
  "shellx.tasks.create": ["src/components/BottomPanel.tsx", "composer-create-task"],
  "shellx.tasks.manager": ["src/components/Header.tsx", "header-tasks"],
  "shellx.tasks.providers": ["src/components/TaskManager.tsx", "task-manager-provider-list"],
  "shellx.tasks.schedule": ["src/components/TaskManager.tsx", "task-manager-trigger-kind"],
  "shellx.tasks.evidence": ["src/components/TaskRunHistory.tsx", "task-manager-history"],
  "shellx.tasks.browser_teach": ["src/browser/components/BrowserTeachReview.tsx", "shellx-browser-teach-create-task"],
  "shellx.interface.settings.general": ["src/components/Settings.tsx", "case \"general\": return \"General\""],
  "shellx.interface.settings.vault": ["src/components/Settings.tsx", "case \"vault\": return \"Vault\""],
  "shellx.interface.vault.workspace.passwords": ["src/components/settings/VaultTab.tsx", "vault-tab-secrets"],
  "shellx.interface.vault.workspace.grants": ["src/components/settings/VaultTab.tsx", "vault-tab-grants"],
  "shellx.interface.vault.workspace.setup": ["src/components/settings/VaultTab.tsx", "vault-tab-setup"],
  "shellx.interface.vault.resource.password_key": ["src/lib/vault-resource-model.ts", '{ id: "secret", label: "Passwords & keys"'],
  "shellx.interface.vault.resource.profile": ["src/lib/vault-resource-model.ts", '{ id: "profileCard", label: "Profile cards"'],
  "shellx.interface.vault.resource.agent_wallet": ["src/lib/vault-resource-model.ts", '{ id: "stripeAgentWallet", label: "Agent wallets"'],
  "shellx.interface.settings.connections": ["src/components/Settings.tsx", "case \"connections\": return \"Connections\""],
  "shellx.interface.settings.connectors": ["src/components/Settings.tsx", "case \"connectors\": return \"Connectors\""],
  "shellx.interface.settings.desktop": ["src/components/Settings.tsx", "case \"desktop\": return \"Desktop\""],
  "shellx.interface.settings.shellxagent": ["src/components/Settings.tsx", "case \"shellxagent\": return \"shellXagent\""],
  "shellx.interface.settings.data": ["src/components/Settings.tsx", "case \"data\": return \"Data\""],
  "shellx.interface.settings.about": ["src/components/Settings.tsx", "case \"about\": return \"About\""],
  "shellx.browser.ui.new_tab": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-new-tab"],
  "shellx.browser.ui.disposable_tab": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-new-disposable-tab"],
  "shellx.browser.ui.agent_lock": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-lock-tab"],
  "shellx.browser.ui.personal_lock": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-personal-lock-toggle"],
  "shellx.browser.ui.handoff": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-handoff-tab"],
  "shellx.browser.ui.take_back": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-take-back-tab"],
  "shellx.browser.ui.right_panel_toggle": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-show-right-sidebar-button", "src/browser/components/AgentSidebar.tsx", "shellx-browser-toggle-right-sidebar-button"],
  "shellx.browser.ui.back": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-back"],
  "shellx.browser.ui.forward": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-forward"],
  "shellx.browser.ui.reload": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-reload"],
  "shellx.browser.ui.home": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-home"],
  "shellx.browser.ui.trust": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-trust-chip"],
  "shellx.browser.ui.address": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-address"],
  "shellx.browser.ui.copy_address": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-copy-address"],
  "shellx.browser.ui.bookmark_current": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-bookmark-current"],
  "shellx.browser.ui.vault_fill": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-vault-fill-menu"],
  "shellx.browser.ui.downloads": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-downloads-menu"],
  "shellx.browser.ui.bookmarks": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-bookmarks-menu"],
  "shellx.browser.ui.history": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-history-menu"],
  "shellx.browser.ui.save": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-save-page"],
  "shellx.browser.ui.ads": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-ad-filter"],
  "shellx.browser.ui.options": ["src/browser/components/BrowserChrome.tsx", "shellx-browser-options"],
  "shellx.browser.save.full_page": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-save-fullpage-screenshot"],
  "shellx.browser.save.window": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-save-screenshot"],
  "shellx.browser.save.markdown": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-save-markdown"],
  "shellx.browser.save.links": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-save-links"],
  "shellx.browser.save.snapshot": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-save-snapshot"],
  "shellx.browser.save.media": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-save-media"],
  "shellx.browser.save.code": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-save-code"],
  "shellx.browser.save.site": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-save-site"],
  "shellx.browser.ads.balanced": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-ad-mode-balanced"],
  "shellx.browser.ads.strict": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-ad-mode-strict"],
  "shellx.browser.ads.off": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-ad-mode-off"],
  "shellx.browser.options.color": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-color-mode"],
  "shellx.browser.options.homepage": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-homepage"],
  "shellx.browser.options.profile": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-profile-select"],
  "shellx.browser.options.sidebar": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-toggle-right-sidebar"],
  "shellx.browser.options.personal_lock_enable": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-personal-lock-enabled"],
  "shellx.browser.options.personal_lock_timeout": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-personal-lock-timeout"],
  "shellx.browser.options.personal_lock_auth": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-personal-lock-auth-mode"],
  "shellx.browser.options.personal_lock_pin": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-personal-lock-set-pin"],
  "shellx.browser.options.personal_lock_cover": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-personal-lock-blur"],
  "shellx.browser.options.personal_lock_pause": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-personal-lock-pause-delegated"],
  "shellx.browser.options.personal_lock_sleep": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-personal-lock-sleep"],
  "shellx.browser.options.personal_lock_minimize": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-personal-lock-minimize"],
  "shellx.browser.options.parallel_agents": ["src/browser/components/BrowserMenus.tsx", "shellx-browser-parallel-agents"],
  "shellx.browser.panel.chat": ["src/browser/components/AgentSidebar.tsx", "shellx-browser-right-tab-chat"],
  "shellx.browser.panel.requests": ["src/browser/components/AgentSidebar.tsx", "shellx-browser-right-tab-requests"],
  "shellx.browser.panel.actions": ["src/browser/components/AgentSidebar.tsx", "shellx-browser-right-tab-actions"],
  "shellx.browser.panel.actions_tasks": ["src/browser/components/AgentSidebar.tsx", "shellx-browser-collapse-tasks"],
  "shellx.browser.panel.actions_receipts": ["src/browser/components/AgentSidebar.tsx", "shellx-browser-collapse-receipts"],
  "shellx.browser.panel.evidence": ["src/browser/components/AgentSidebar.tsx", "shellx-browser-right-tab-evidence"],
  "shellx.browser.panel.errors": ["src/browser/components/AgentSidebar.tsx", "shellx-browser-right-tab-errors"],
  "shellx.browser.panel.errors_console": ["src/browser/components/AgentSidebar.tsx", "shellx-browser-collapse-console"],
  "shellx.browser.sidecar.history_scopes": ["src/browser/components/BrowserHistorySidecar.tsx", "shellx-browser-history-user", "shellx-browser-history-agent"],
  "shellx.browser.sidecar.history_filters": ["src/browser/components/BrowserHistorySidecar.tsx", "shellx-browser-history-search", "shellx-browser-history-date-filter"],
  "shellx.browser.sidecar.clear_history": ["src/browser/components/BrowserHistorySidecar.tsx", "shellx-browser-clear-history"],
  "shellx.browser.sidecar.bookmark_list": ["src/browser/components/BookmarkSidecar.tsx", "shellx-browser-bookmark-list-mode", "shellx-browser-bookmark-list"],
  "shellx.browser.sidecar.bookmark_manager": ["src/browser/components/BookmarkSidecar.tsx", "shellx-browser-bookmark-manager-toggle", "shellx-browser-bookmark-manager"],
  "shellx.browser.sidecar.download_folder": ["src/browser/components/DownloadSidecar.tsx", "shellx-browser-download-folder", "shellx-browser-download-folder-choose"],
  "shellx.browser.sidecar.download_list": ["src/browser/components/DownloadSidecar.tsx", "shellx-browser-download-list"],
};

const documentedSurfaces = content.sections
  .filter((section) => section.id === "interface" || section.id === "tasks" || section.id === "browser-interface")
  .flatMap((section) => section.features);
const documentedIds = new Set(documentedSurfaces.map((feature) => feature.id));
const coverageIds = new Set(Object.keys(coverage));
const visualIds = new Set(Object.keys(visuals.features ?? {}));

const appSource = source("src/App.tsx");
const paletteSource = appSource.slice(
  appSource.indexOf("const paletteActions = useMemo<PaletteAction[]>") ,
  appSource.indexOf("async function setAutonomyAndPersist"),
);
const paletteActionIds = new Set([...paletteSource.matchAll(/\bid:\s*"(act-[^"]+)"/g)].map((match) => match[1]));
const documentedPaletteActionIds = new Set(
  Object.entries(coverage)
    .filter(([featureId]) => featureId.startsWith("shellx.interface.command.") && featureId !== "shellx.interface.command.slash_commands")
    .flatMap(([, mapping]) => mapping.filter((marker) => marker.startsWith('id: "act-')).map((marker) => marker.slice(5, -1))),
);
assert(
  JSON.stringify([...paletteActionIds].sort()) === JSON.stringify([...documentedPaletteActionIds].sort()),
  `command-palette docs do not exactly cover the ${paletteActionIds.size} static action ids`,
);

assert(documentedSurfaces.length === coverageIds.size, `surface inventory has ${documentedSurfaces.length} docs entries but ${coverageIds.size} source mappings`);
assert(documentedSurfaces.length === visualIds.size, `surface inventory has ${documentedSurfaces.length} docs entries but ${visualIds.size} visual mappings`);
assert(Object.keys(visuals.captures ?? {}).length >= 18, "manual must use a real multi-surface UI atlas, not one generic screenshot");
for (const feature of documentedSurfaces) {
  assert(coverageIds.has(feature.id), `surface docs entry is not source-mapped: ${feature.id}`);
  assert(typeof feature.summary === "string" && feature.summary.trim().length >= 48, `surface explanation is too short: ${feature.id}`);
  assert(generatedHtml.includes(`data-feature-id="${feature.id}"`), `generated manual is missing feature article ${feature.id}`);
  assert(generatedHtml.includes(`data-feature-link="${feature.id}"`), `generated manual is missing navigation item ${feature.id}`);
  assert(visualIds.has(feature.id), `surface docs entry has no highlighted visual: ${feature.id}`);
  assert(generatedHtml.includes(`"${feature.id}":`), `generated manual interface map is missing ${feature.id}`);
}
for (const [id, mapping] of Object.entries(coverage)) {
  assert(documentedIds.has(id), `source-mapped UI surface is missing from docs: ${id}`);
  let currentPath = mapping[0];
  for (let index = 1; index < mapping.length; index += 1) {
    const value = mapping[index];
    if (value.startsWith("src/")) {
      currentPath = value;
      continue;
    }
    assert(source(currentPath).includes(value), `${id} source marker is missing from ${currentPath}: ${value}`);
  }
}

function pngDimensions(buffer, label) {
  assert(buffer.length > 24, `${label} is too small to be a PNG capture`);
  assert(buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${label} is not a PNG capture`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const usedCaptures = new Set();
for (const feature of documentedSurfaces) {
  const visual = visuals.features[feature.id];
  const capture = visuals.captures[visual.capture];
  assert(capture, `${feature.id} references missing capture ${visual.capture}`);
  usedCaptures.add(visual.capture);
  assert(Array.isArray(visual.focus) && visual.focus.length === 4, `${feature.id} must define one focus rectangle`);
  const [x, y, width, height] = visual.focus;
  assert([x, y, width, height].every(Number.isFinite), `${feature.id} focus rectangle must be numeric`);
  assert(x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 100.01 && y + height <= 100.01, `${feature.id} focus rectangle is outside its image`);
  const path = join(repoRoot, "docs/public/manual/shellx", capture.file);
  assert(existsSync(path), `${feature.id} capture is missing: ${capture.file}`);
  const image = readFileSync(path);
  assert(image.length >= 20_000, `${feature.id} capture is suspiciously small: ${capture.file}`);
  const dimensions = pngDimensions(image, capture.file);
  assert(dimensions.width === capture.width && dimensions.height === capture.height, `${capture.file} dimensions do not match visuals.json`);
  assert(generatedHtml.includes(`"file":"${capture.file}"`), `${feature.id} capture is not available to the interactive map`);
}
assert(usedCaptures.size === Object.keys(visuals.captures).length, "manual visuals contain unused captures");
for (const tab of ["general", "vault", "connections", "connectors", "desktop", "shellxagent", "data", "about"]) {
  assert(visuals.features[`shellx.interface.settings.${tab}`]?.capture === `settings-${tab}`, `Settings ${tab} must show its own active tab capture`);
}
for (const [feature, capture] of Object.entries({
  tasks: "right-rail-tasks",
  tools: "right-rail-tools",
  git: "right-rail-git",
  preview: "right-rail-preview",
  plan: "right-rail-plan",
  files: "right-rail-files",
})) {
  assert(visuals.features[`shellx.interface.right.${feature}`]?.capture === capture, `Right rail ${feature} must show its selected panel`);
}
for (const [feature, capture] of Object.entries({
  terminal: "bottom-terminal",
  trace: "bottom-trace",
  assets: "bottom-assets",
  logs: "bottom-logs",
  stderr: "bottom-stderr",
})) {
  assert(visuals.features[`shellx.interface.bottom.${feature}`]?.capture === capture, `Bottom panel ${feature} must show its opened state`);
}
for (const panel of ["chat", "requests", "actions", "evidence", "errors"]) {
  assert(visuals.features[`shellx.browser.panel.${panel}`]?.capture === `browser-panel-${panel}`, `Browser ${panel} must show its selected right-panel state`);
}
assert(visuals.features["shellx.interface.header.settings"]?.capture === "settings-general", "Header Settings must open the Settings surface");
assert(visuals.features["shellx.interface.header.requests"]?.capture === "header-requests", "Header Requests must open the request popover");
assert(visuals.features["shellx.interface.header.plugins"]?.capture === "header-plugins", "Header Plugins must open the plugin catalog");
for (const id of documentedPaletteActionIds) {
  if (id === "act-preview-doctor") continue;
  const feature = Object.entries(coverage).find(([, mapping]) => mapping.includes(`id: "${id}"`))?.[0];
  assert(visuals.features[feature]?.capture === "command-palette", `${id} must show the opened Command Palette row`);
}
assert(
  visuals.features["shellx.interface.command.preview_doctor"]?.capture === "right-rail-preview"
    && visuals.features["shellx.interface.command.preview_doctor"]?.note?.includes("conditional"),
  "conditional Preview Doctor docs must show its real destination without inventing an idle palette row",
);
assert(visuals.features["shellx.interface.command.slash_commands"]?.capture === "command-palette", "dynamic slash commands must show the opened Command Palette");
assert(visuals.features["shellx.browser.save.code"]?.capture === "browser-save-copy-jobs", "Browser code-copy docs must show the scrolled Copy jobs menu");
assert(visuals.features["shellx.browser.save.site"]?.capture === "browser-save-copy-jobs", "Browser site-copy docs must show the scrolled Copy jobs menu");

assert(
  manualJs.includes("searchParams.get(\"feature\")")
    && manualJs.includes("classList.toggle(\"active\"")
    && manualJs.includes("classList.toggle(\"highlighted\"")
    && manualJs.includes("updateInterfaceMap")
    && manualJs.includes('interfaceMapImage.setAttribute("src", imagePath)')
    && manualJs.includes("highlight.style.left"),
  "manual deep-link selection and active menu highlighting are not wired",
);
assert((generatedHtml.match(/data-manual-highlight/g) ?? []).length === 1, "manual must render exactly one moving interface highlight");
assert((generatedHtml.match(/data-interface-map-image/g) ?? []).length === 1, "manual must render exactly one switchable interface image");
assert(!generatedHtml.includes("data-feature-visual="), "manual must not repeat a screenshot under every feature article");
assert(!manualCss.includes(".feature-visual"), "legacy repeated feature-visual CSS must be removed");
for (const marker of [
  `manual.css?v=${content.version}.${content.revision}`,
  `manual.js?v=${content.version}.${content.revision}`,
  'class="manual-topbar"',
  'class="manual-brand"',
  'class="manual-topnav"',
  'class="manual-shell"',
]) {
  assert(generatedHtml.includes(marker), `manual family styling marker is missing: ${marker}`);
}
for (const marker of [
  '--bg-0: #050505',
  '--line: #1d1d1d',
  '--ink-0: #f5f5f4',
  '--display: "Fraunces", "Times New Roman", serif',
  '--body: "Onest", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  '--mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
  'min-height: 64px',
  'grid-template-columns: 304px minmax(0, 1fr)',
]) {
  assert(manualCss.includes(marker), `manual CSS has drifted from the shared family marker: ${marker}`);
}
process.stdout.write(`ShellX docs map ${documentedSurfaces.length} interface surfaces to live source markers, deep links, ${usedCaptures.size} switchable UI states, and one interactive highlight\n`);
