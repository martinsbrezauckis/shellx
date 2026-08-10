import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BOTTOM_PANEL_TABS,
  COMPOSER_DEBUG_MENUS,
  DEBUG_MODAL_IDS,
  RIGHT_RAIL_TABS,
  type BottomTab,
  type ComposerDebugMenu,
  type DebugModalId,
  type RightTab,
} from "../src/lib/ui-navigation";
import { ALL_SETTINGS_TABS, type SettingsTab } from "../src/lib/settings";
import { collectReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import { exploreUiStateSpace, type UiStateSpaceAction } from "./lib/ui-state-space";

const root = resolve(import.meta.dirname, "..");
const viewports = ["wide", "compact", "narrow"] as const;
type Viewport = typeof viewports[number];

interface ChromeState {
  rightTab: RightTab;
  bottomTab: BottomTab;
  media: "empty" | "available";
  viewport: Viewport;
}

interface ModalState {
  modal: Exclude<DebugModalId, "close"> | null;
  settingsTab: SettingsTab;
  viewport: Viewport;
}

interface ComposerState {
  bottomTab: BottomTab;
  menu: Exclude<ComposerDebugMenu, "close"> | null;
  locked: boolean;
  viewport: Viewport;
}

assertSourceBindings();

const chrome = exploreUiStateSpace<ChromeState>({
  name: "shell chrome navigation",
  initial: { rightTab: "Tasks", bottomTab: "Chat", media: "empty", viewport: "wide" },
  actions: [
    ...RIGHT_RAIL_TABS.map((rightTab): UiStateSpaceAction<ChromeState> => ({
      id: `right:${rightTab}`,
      apply: (state) => ({ ...state, rightTab }),
    })),
    ...BOTTOM_PANEL_TABS.map((bottomTab): UiStateSpaceAction<ChromeState> => ({
      id: `bottom:${bottomTab}`,
      apply: (state) => state.media === "empty" && (bottomTab === "Images" || bottomTab === "Videos")
        ? null
        : { ...state, bottomTab },
    })),
    {
      id: "media:empty",
      apply: (state) => ({
        ...state,
        media: "empty",
        bottomTab: state.bottomTab === "Images" || state.bottomTab === "Videos" ? "Chat" : state.bottomTab,
      }),
    },
    { id: "media:available", apply: (state) => ({ ...state, media: "available" }) },
    ...viewportActions<ChromeState>(),
  ],
  key: (state) => `${state.rightTab}|${state.bottomTab}|${state.media}|${state.viewport}`,
  validate: (state) => {
    assert(RIGHT_RAIL_TABS.includes(state.rightTab), `unknown right tab ${state.rightTab}`);
    assert(BOTTOM_PANEL_TABS.includes(state.bottomTab), `unknown bottom tab ${state.bottomTab}`);
    assert(viewports.includes(state.viewport), `unknown viewport ${state.viewport}`);
    assert(
      state.media === "available" || (state.bottomTab !== "Images" && state.bottomTab !== "Videos"),
      "empty media state cannot retain an Images or Videos tab",
    );
  },
  expectedStateCount: 180,
  maxStateCount: 250,
});

const modal = exploreUiStateSpace<ModalState>({
  name: "modal and settings navigation",
  initial: { modal: null, settingsTab: "general", viewport: "wide" },
  actions: [
    ...DEBUG_MODAL_IDS.map((modalId): UiStateSpaceAction<ModalState> => ({
      id: `modal:${modalId}`,
      apply: (state) => ({
        ...state,
        modal: modalId === "close" ? null : modalId,
      }),
    })),
    ...ALL_SETTINGS_TABS.map((settingsTab): UiStateSpaceAction<ModalState> => ({
      id: `settings:${settingsTab}`,
      apply: (state) => state.modal === "settings" ? { ...state, settingsTab } : null,
    })),
    ...viewportActions<ModalState>(),
  ],
  key: (state) => `${state.modal ?? "none"}|${state.settingsTab}|${state.viewport}`,
  validate: (state) => {
    assert(
      state.modal === null || DEBUG_MODAL_IDS.includes(state.modal),
      `unknown modal ${String(state.modal)}`,
    );
    assert(ALL_SETTINGS_TABS.includes(state.settingsTab), `unknown settings tab ${state.settingsTab}`);
    assert(viewports.includes(state.viewport), `unknown viewport ${state.viewport}`);
  },
  expectedStateCount: 312,
  maxStateCount: 400,
});

const composer = exploreUiStateSpace<ComposerState>({
  name: "composer menu navigation",
  initial: { bottomTab: "Chat", menu: null, locked: false, viewport: "wide" },
  actions: [
    ...BOTTOM_PANEL_TABS.map((bottomTab): UiStateSpaceAction<ComposerState> => ({
      id: `bottom:${bottomTab}`,
      apply: (state) => ({ ...state, bottomTab }),
    })),
    ...COMPOSER_DEBUG_MENUS.map((menu): UiStateSpaceAction<ComposerState> => ({
      id: `composer:${menu}`,
      apply: (state) => ({
        ...state,
        bottomTab: "Chat",
        menu: menu === "close" || (state.locked && (menu === "connection" || menu === "agent"))
          ? null
          : menu,
      }),
    })),
    {
      id: "scope:lock",
      apply: (state) => ({
        ...state,
        locked: true,
        menu: state.menu === "connection" || state.menu === "agent" ? null : state.menu,
      }),
    },
    { id: "scope:unlock", apply: (state) => ({ ...state, locked: false }) },
    ...viewportActions<ComposerState>(),
  ],
  key: (state) => `${state.bottomTab}|${state.menu ?? "none"}|${state.locked ? "locked" : "open"}|${state.viewport}`,
  validate: (state) => {
    assert(BOTTOM_PANEL_TABS.includes(state.bottomTab), `unknown bottom tab ${state.bottomTab}`);
    assert(
      state.menu === null || COMPOSER_DEBUG_MENUS.includes(state.menu),
      `unknown composer menu ${String(state.menu)}`,
    );
    assert(
      !state.locked || (state.menu !== "connection" && state.menu !== "agent"),
      "locked session cannot retain connection or agent picker",
    );
    assert(viewports.includes(state.viewport), `unknown viewport ${state.viewport}`);
  },
  expectedStateCount: 144,
  maxStateCount: 160,
});

console.log("ShellX bounded UI state-space walker passed");
for (const result of [chrome, modal, composer]) {
  console.log(
    `  ${result.name}: ${result.stateCount} states, ${result.transitionCount} transitions, `
    + `${result.changedActionCount} live actions, depth ${result.maxDepth}`,
  );
}

function viewportActions<State extends { viewport: Viewport }>(): UiStateSpaceAction<State>[] {
  return viewports.map((viewport) => ({
    id: `viewport:${viewport}`,
    apply: (state) => ({ ...state, viewport }),
  }));
}

function assertSourceBindings(): void {
  const app = read("src/App.tsx");
  const rightRail = read("src/components/RightRail.tsx");
  const bottomPanel = read("src/components/BottomPanel.tsx");
  const settings = read("src/components/Settings.tsx");
  const browserApp = read("src/components/ShellxBrowserApp.tsx");
  const interactionCss = read("src/styles/interactionAccessibility.css");
  const browserCss = read("src/browser/browserShell.css");

  assert(app.includes("normalizeRightTabPatch") && app.includes("normalizeDebugModal"));
  assert(!app.includes("const RIGHT_TAB_IDS"), "App must not duplicate the navigation registries");
  assert(rightRail.includes("RIGHT_RAIL_TABS.map"), "Right rail must render the canonical tab registry");
  assert(rightRail.includes('role="tablist"') && rightRail.includes('role="tab"'));
  assert(rightRail.includes("aria-selected={tab === rightTab}"));
  assert(rightRail.includes("handleTabKeyDown"), "Right rail tabs require roving keyboard navigation");
  for (const tab of RIGHT_RAIL_TABS) {
    assert(rightRail.includes(`${tab}: {`), `Right rail metadata missing ${tab}`);
  }
  assert(bottomPanel.includes("isBottomTab(value)"), "Bottom tab persistence must use the canonical registry");
  for (const tab of BOTTOM_PANEL_TABS) {
    assert(
      bottomPanel.includes(`data-debug-id="bottom-tab-${tab.toLowerCase()}"`),
      `Bottom tab ${tab} lacks a stable navigation selector`,
    );
  }
  assert(!bottomPanel.includes("disabled={imageCount === 0}"), "Images tab must expose its intentional empty state");
  assert(!bottomPanel.includes("disabled={videoCount === 0}"), "Videos tab must expose its intentional empty state");
  assert(bottomPanel.includes('No {kind === "image" ? "images" : "videos"} in this session yet.'));
  assert(settings.includes("ALL_SETTINGS_TABS.map"), "Settings must render its canonical tab registry");
  assert(settings.includes("handleTabKeyDown"), "Settings tabs require roving keyboard navigation");
  for (const tab of ALL_SETTINGS_TABS) {
    assert(settings.includes(`renderedTab === "${tab}"`), `Settings tab ${tab} has no content branch`);
  }
  const modalHandler = functionBody(app, "function openDebugModal");
  for (const modalId of DEBUG_MODAL_IDS) {
    assert(modalHandler.includes(`"${modalId}"`), `Debug modal ${modalId} has no transition branch`);
  }
  for (const menu of COMPOSER_DEBUG_MENUS) {
    assert(bottomPanel.includes(`debugOpenMenu === "${menu}"`) || menu === "close", `Composer menu ${menu} has no handler`);
  }

  assert(!browserApp.includes("gridTemplateColumns"), "Browser responsive grid must not be overridden inline");
  assert(
    /@media \(max-width: 980px\)[\s\S]*?\.shellx-browser-grid\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(browserCss),
    "Browser grid needs a narrow viewport single-column override",
  );
  assert(interactionCss.includes("@media (prefers-reduced-motion: reduce)"));
  assert(browserCss.includes("@media (prefers-reduced-motion: reduce)"));

  const inventory = collectReleaseSurfaceInventory(root);
  const stableSelectors = new Set(
    inventory.items
      .filter((item) => item.kind === "ui-control" && item.stableSelector)
      .map((item) => item.selector),
  );
  for (const tab of RIGHT_RAIL_TABS) {
    assert(stableSelectors.has(`[data-debug-id="right-tab-${tab.toLowerCase()}"]`));
  }
  for (const tab of ALL_SETTINGS_TABS) {
    assert(stableSelectors.has(`[data-debug-id="settings-tab-${tab}"]`));
  }
  for (const tab of BOTTOM_PANEL_TABS) {
    assert(stableSelectors.has(`[data-debug-id="bottom-tab-${tab.toLowerCase()}"]`));
  }
}

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert(start >= 0, `missing ${signature}`);
  const nextFunction = source.indexOf("\n  function ", start + signature.length);
  return source.slice(start, nextFunction >= 0 ? nextFunction : undefined);
}
