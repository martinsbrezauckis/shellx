import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { SHORTCUTS } from "../src/lib/shortcuts";
import { normalizedTextContent } from "./lib/text-content";
import { readAppStyles } from "./lib/app-styles";

const leftRail = readFileSync("src/components/LeftRail.tsx", "utf8");
const rowActions = readFileSync("src/components/RowActions.tsx", "utf8");
const filesPane = readFileSync("src/components/FilesPane.tsx", "utf8");
const connectionPicker = readFileSync("src/components/ConnectionPicker.tsx", "utf8");
const connectionsTab = readFileSync("src/components/settings/ConnectionsTab.tsx", "utf8");
const pluginsModal = readFileSync("src/components/PluginsModal.tsx", "utf8");
const pluginsModalCss = readFileSync("src/components/PluginsModal.css", "utf8");
const connectorInbox = readFileSync("src/components/ConnectorInboxModal.tsx", "utf8");
const connectorInboxCss = readFileSync("src/components/ConnectorInboxModal.css", "utf8");
const settings = readFileSync("src/components/Settings.tsx", "utf8");
const settingsCss = readFileSync("src/components/Settings.css", "utf8");
const appCss = readAppStyles();
const agentSidebar = readFileSync("src/browser/components/AgentSidebar.tsx", "utf8");
const browserHistorySidecar = readFileSync("src/browser/components/BrowserHistorySidecar.tsx", "utf8");
const browserTabHandoffConfirmation = readFileSync("src/browser/components/BrowserTabHandoffConfirmation.tsx", "utf8");
const browserLayoutCss = readFileSync("src/browser/browserLayout.css", "utf8");
const chatOutput = normalizedTextContent(readFileSync("src/components/ChatOutput.tsx", "utf8"));
const modalFocus = readFileSync("src/lib/useModalFocus.ts", "utf8");
const main = readFileSync("src/main.tsx", "utf8");
const findPopover = readFileSync("src/components/FindPopover.tsx", "utf8");
const shortcuts = readFileSync("src/lib/shortcuts.ts", "utf8");
const activityBrowser = readFileSync("src/components/ActivityBrowserModal.tsx", "utf8");
const commandPalette = readFileSync("src/components/CommandPalette.tsx", "utf8");
const commandPaletteCss = readFileSync("src/components/CommandPalette.css", "utf8");
const bottomPanel = readFileSync("src/components/BottomPanel.tsx", "utf8");
const branchPicker = readFileSync("src/components/BranchPicker.tsx", "utf8");
const css = readFileSync("src/styles/interactionAccessibility.css", "utf8");

console.log("\n=== keyboard-complete operational controls ===");

assert(leftRail.includes('className="left-collapse-all"') && leftRail.includes('className="proj-row-main"'));
assert(leftRail.includes('className="chat-row-main"') && leftRail.includes('className="unfiled-row-main"'));
assert(leftRail.includes("isKeyboardContextMenu") && leftRail.includes('role="menuitem"'));
assert(rowActions.includes("<button") && !rowActions.includes("tabIndex={-1}"));
assert(filesPane.includes('className="fv-row-main"'));
assert(
  connectionPicker.includes('className="connection-row-main"')
    && connectionPicker.includes('role="alertdialog"')
    && connectionPicker.includes('aria-modal="true"')
    && connectionPicker.includes('setAttribute("inert", "")')
    && connectionPicker.includes("deleteCancelRef.current?.focus()")
    && connectionPicker.includes('event.key !== "Tab"'),
  "connection deletion must default focus to Cancel and trap keyboard focus inside its in-app confirmation",
);
assert(
  connectionPicker.includes('"Connection reachable"')
    && connectionPicker.includes('"Connection test failed"')
    && connectionPicker.includes('"Connection not tested"')
    && !connectionPicker.includes('"untested or unreachable"'),
  "connection status must distinguish untested, reachable, and failed states without relying on color",
);
assert(
  connectionsTab.includes('role="alertdialog"')
    && connectionsTab.includes('aria-label="Delete saved connection"')
    && connectionsTab.includes('setAttribute("inert", "")')
    && connectionsTab.includes("deleteCancelRef.current?.focus()")
    && connectionsTab.includes('event.key !== "Tab"')
    && !connectionsTab.includes("window.confirm"),
  "Settings connection deletion must use the same keyboard-safe in-app confirmation boundary",
);
assert(
  pluginsModal.includes('className="mp-tier-button"')
    && pluginsModal.includes("aria-expanded={!collapsed}")
    && pluginsModalCss.includes(".mp-tier-button:focus-visible")
    && pluginsModalCss.includes("outline: 1px solid var(--accent);"),
  "Plugins tier disclosures expose state and a visible keyboard focus boundary",
);
assert(
  connectorInbox.includes('role="tab"')
    && connectorInbox.includes("aria-selected={active}")
    && connectorInboxCss.includes(".connector-inbox-tab:focus-visible"),
  "Connector inbox tabs expose selection and a visible keyboard focus boundary",
);
assert(settings.includes("useModalFocus(open, dialogRef, onClose)") && settings.includes("handleTabKeyDown"));
assert(settings.includes('role="tabpanel"') && settings.includes("aria-labelledby={`settings-tab-${renderedTab}`}"));
assert(
  settings.includes('import "./Settings.css"')
    && settingsCss.includes(".settings-tab:focus-visible")
    && appCss.includes(".settings-close:focus-visible"),
  "Settings tabs and the shared dialog close button expose visible keyboard focus boundaries",
);
assert(agentSidebar.includes("AGENT_SIDEBAR_PANEL_ORDER"));
assert(agentSidebar.includes('event.key === "ArrowRight"') && agentSidebar.includes('event.key === "ArrowLeft"'));
assert(agentSidebar.includes('event.key === "Home"') && agentSidebar.includes('event.key === "End"'));
assert(agentSidebar.includes("tabIndex={rightPanelTab === \"chat\" ? 0 : -1}"));
assert(activityBrowser.includes("handleNodeKeyDown") && activityBrowser.includes("event.currentTarget.focus({ preventScroll: true })"));
assert(activityBrowser.includes('data-shellx-release-observe="pressed focused"') && activityBrowser.includes('data-shellx-release-observe="expanded disabled"'));
assert(
  commandPalette.includes('role="combobox"')
    && commandPalette.includes('role="listbox"')
    && commandPalette.includes('role="option"')
    && commandPalette.includes("aria-activedescendant={activeOptionId}")
    && commandPalette.includes("aria-selected={i === idx}"),
  "Command Palette must expose its active keyboard selection through combobox/listbox semantics",
);
assert(
  commandPalette.includes('import "./CommandPalette.css"')
    && commandPaletteCss.includes(".palette-input:focus-visible")
    && commandPaletteCss.includes(".palette-row:focus-visible"),
  "Command Palette must load its component-owned visible focus contract",
);
assert(pluginsModal.includes("useModalFocus(open, dialogRef, onClose)") && pluginsModal.includes('role="dialog"'));
assert(modalFocus.includes("inertOutsideDialog") && modalFocus.includes('event.key !== "Tab"'));
assert(modalFocus.includes("previousFocus.focus") && modalFocus.includes('event.key === "Escape"'));
assert(
  browserHistorySidecar.includes('role="alertdialog"')
    && browserHistorySidecar.includes("useModalFocus(")
    && browserHistorySidecar.includes('data-dialog-initial-focus="true"')
    && browserHistorySidecar.includes('aria-busy={busy}')
    && !browserHistorySidecar.includes("window.confirm")
    && browserLayoutCss.includes(".shellx-browser-history-confirmation-actions .shellx-browser-utility-row:focus-visible"),
  "Browser history clearing must trap focus, restore to a non-destructive default, cancel with Escape, expose busy state, and avoid native confirms",
);
assert(
  browserTabHandoffConfirmation.includes('role="alertdialog"')
    && browserTabHandoffConfirmation.includes("useModalFocus(")
    && browserTabHandoffConfirmation.includes('data-dialog-initial-focus="true"')
    && browserTabHandoffConfirmation.includes("Cancel")
    && browserTabHandoffConfirmation.includes('aria-busy={handoffBusy}')
    && browserTabHandoffConfirmation.includes("if (!handoffBusy) onCancel();"),
  "Browser tab handoff must trap focus, restore to a non-destructive Cancel default, cancel with Escape, and expose truthful busy state",
);
assert(chatOutput.includes('<button\n      type="button"\n      className="row-pill doom-loop"'));
assert(chatOutput.includes('<button\n      type="button"\n      className="row-pill host-mcp-unreachable"'));
assert(main.includes('import "./styles/interactionAccessibility.css"'));
assert(css.includes(".ctxmenu-action:focus-visible") && css.includes(".fv-row-main:focus-visible"));
assert(shortcuts.includes('id: "palette"') && shortcuts.includes('desc: "Open command palette"'));
const toggleTerminal = SHORTCUTS.find((shortcut) => shortcut.id === "toggle-terminal");
assert(toggleTerminal, "toggle-terminal shortcut must remain registered");
const platformCommandModifier = typeof navigator !== "undefined"
  && /Mac|iPhone|iPad/.test(navigator.platform)
  ? { ctrlKey: false, metaKey: true }
  : { ctrlKey: true, metaKey: false };
assert(
  toggleTerminal.match({
    key: "§",
    code: "Backquote",
    ...platformCommandModifier,
  } as KeyboardEvent),
  "the terminal shortcut must recognize the physical Backquote key on non-US keyboard layouts",
);
assert(
  !toggleTerminal.match({
    key: "§",
    code: "Digit1",
    ...platformCommandModifier,
  } as KeyboardEvent),
  "the terminal shortcut must not broaden to unrelated physical keys",
);
assert(
  !SHORTCUTS.some((shortcut) => shortcut.id === "cycle-autonomy")
    && !SHORTCUTS.some((shortcut) => shortcut.match({ key: "Tab", shiftKey: true } as KeyboardEvent)),
  "Shift+Tab must remain native reverse-focus navigation and must never change autonomy",
);
assert(
  shortcuts.includes("const handlersRef = useRef(handlers)")
    && shortcuts.includes("handlersRef.current[sc.id]")
    && shortcuts.includes("}, []);"),
  "global shortcut listener must stay mounted while dispatching through the latest handler ref",
);
assert(
  !findPopover.includes('(e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k"'),
  "Find must not steal the Command Palette shortcut and open two overlays",
);
assert(
  findPopover.includes("const previewRequestSeq = useRef(0)")
    && findPopover.includes("const requestSeq = ++previewRequestSeq.current")
    && findPopover.includes("previewRequestSeq.current === requestSeq"),
  "only the newest Find preview request may clear its loading state",
);
assert(
  !bottomPanel.includes("onCreateWorktree") && !branchPicker.includes("onCreateWorktree"),
  "composer branch selection must not retain a dead worktree callback contract",
);
assert(
  bottomPanel.includes('"Pick connection — Local / WSL / SSH"') &&
    !bottomPanel.includes("Local / WSL / SSH / Tailscale"),
  "composer connection help must advertise only routes the Connection Editor can create",
);
assert(
  bottomPanel.includes('title="Pick branch for this tab"') &&
    !bottomPanel.includes("also offers +create worktree from branch"),
  "composer branch help must not promise worktree creation that lives in the Git rail",
);
assert.deepEqual(
  titleOnlyIconButtons("src"),
  [],
  "icon-only buttons must expose aria-label or aria-labelledby instead of relying on hover-only title text",
);

console.log("PASS keyboard accessibility contracts");

function titleOnlyIconButtons(root: string): string[] {
  const violations: string[] = [];
  for (const file of tsxFiles(root)) {
    const sourceText = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "button") {
        const attrs = node.openingElement.attributes.properties;
        const hasTitle = attrs.some((attr) => ts.isJsxAttribute(attr) && attr.name.getText(source) === "title");
        const hasAriaName = attrs.some((attr) => ts.isJsxAttribute(attr)
          && (attr.name.getText(source) === "aria-label" || attr.name.getText(source) === "aria-labelledby"));
        const bodyWithoutIcons = node.children.map((child) => child.getText(source)).join("")
          .replace(/<ShellIcon[^>]*\/>/g, "")
          .replace(/<[^>]+>/g, "")
          .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
          .replace(/\s+/g, "")
          .trim();
        if (hasTitle && !hasAriaName && bodyWithoutIcons.length === 0) {
          const location = source.getLineAndCharacterOfPosition(node.openingElement.getStart(source));
          violations.push(`${file}:${location.line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && path.endsWith(".tsx") ? [path] : [];
  });
}
