import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { extractDebugApiRoutePairs } from "./release-surface-rust-routes";

export { extractDebugApiRoutePairs } from "./release-surface-rust-routes";

export const RELEASE_SURFACE_INVENTORY_SCHEMA = "shellx/release-surface-inventory@4";

export const RELEASE_PLATFORMS = [
  "windows-installed",
  "macos-installed",
  "linux-installed",
] as const;

export type ReleasePlatform = typeof RELEASE_PLATFORMS[number];

export type ReleaseSurfaceDelivery = "installed-app" | "installed-sidecar" | "source-package";
export type ReleaseSelectorStability = "durable" | "copy-derived" | "missing";
export type ReleaseUiInteractionFamily =
  | "selection"
  | "disclosure"
  | "toggle"
  | "text-entry"
  | "choice"
  | "range"
  | "file-picker"
  | "activation";
export type ReleaseUiDebugFamily = "static-marker" | "dynamic-marker";
export type ReleaseUiDriverFamily = ReleaseUiInteractionFamily | ReleaseUiDebugFamily;
export type ReleaseUiEventTrust = "native-required" | "not-applicable";

const RELEASE_UI_INTERACTION_FAMILIES = new Set<ReleaseUiInteractionFamily>([
  "selection",
  "disclosure",
  "toggle",
  "text-entry",
  "choice",
  "range",
  "file-picker",
  "activation",
]);

export type ReleaseSurfaceKind =
  | "tauri-command"
  | "debug-api-route"
  | "host-mcp-tool"
  | "browser-cli-command"
  | "palette-action"
  | "keyboard-shortcut"
  | "shellx-command"
  | "ui-debug-surface"
  | "ui-control";

export interface ReleaseSurfaceItem {
  id: string;
  kind: ReleaseSurfaceKind;
  name: string;
  source: string;
  platforms: ReleasePlatform[];
  delivery: ReleaseSurfaceDelivery;
  selector?: string;
  line?: number;
  occurrence?: number;
  finiteVariant?: string;
  stableSelector?: boolean;
  dynamicSelector?: boolean;
  selectorStability?: ReleaseSelectorStability;
  elementTag?: string;
  elementRole?: string;
  inputType?: string;
  driverFamily?: ReleaseUiDriverFamily;
  eventTrust?: ReleaseUiEventTrust;
  advertised?: boolean;
  aliasOf?: string;
}

export interface ReleaseSurfaceInventory {
  schema: typeof RELEASE_SURFACE_INVENTORY_SCHEMA;
  platforms: ReleasePlatform[];
  digest: string;
  counts: Record<ReleaseSurfaceKind, number>;
  unresolvedInteractiveControls: number;
  copyDerivedInteractiveControls: number;
  uiDriverFamilyAccounting: Record<ReleaseUiDriverFamily, number>;
  occurrenceAccounting: {
    uiControls: {
      candidates: number;
      excludedNonActions: number;
      finiteVariantInstances: number;
      inventoried: number;
    };
    uiDebugSurfaces: {
      candidates: number;
      finiteVariantInstances: number;
      inventoried: number;
    };
  };
  items: ReleaseSurfaceItem[];
}

const ALL_PLATFORMS = [...RELEASE_PLATFORMS];
const NATIVE_INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "textarea"]);
const INTERACTIVE_ROLES = new Set(["button", "checkbox", "link", "menuitem", "radio", "switch", "tab"]);
const NON_TEXT_INPUT_TYPES = new Set(["button", "submit", "reset", "image", "hidden"]);
const NON_SHIPPING_UI_SOURCES = new Set([
  "src/components/settings/ReleaseReadinessPanel.tsx",
]);

export function collectReleaseSurfaceInventory(rootDir = resolve(import.meta.dirname, "../..")): ReleaseSurfaceInventory {
  const root = resolve(rootDir);
  const uiDebugSurfaces = collectUiDebugSurfaces(root);
  const uiControls = collectUiControls(root);
  const items: ReleaseSurfaceItem[] = [
    ...collectTauriCommands(root),
    ...collectDebugApiRoutes(root),
    ...collectHostMcpTools(root),
    ...collectBrowserCliCommands(root),
    ...collectPaletteActions(root),
    ...collectKeyboardShortcuts(root),
    ...collectShellxCommands(root),
    ...uiDebugSurfaces.items,
    ...uiControls.items,
  ];

  items.sort((a, b) => a.id.localeCompare(b.id));
  assertUniqueIds(items);

  const counts = emptyCounts();
  for (const item of items) counts[item.kind] += 1;
  const uiDriverFamilyAccounting = emptyUiDriverFamilyAccounting();
  for (const item of items) {
    if (item.driverFamily) uiDriverFamilyAccounting[item.driverFamily] += 1;
  }
  const digest = createHash("sha256").update(JSON.stringify(items)).digest("hex");

  return {
    schema: RELEASE_SURFACE_INVENTORY_SCHEMA,
    platforms: [...RELEASE_PLATFORMS],
    digest,
    counts,
    unresolvedInteractiveControls: items.filter(
      (item) => item.kind === "ui-control" && item.stableSelector !== true,
    ).length,
    copyDerivedInteractiveControls: items.filter(
      (item) => item.kind === "ui-control" && item.selectorStability === "copy-derived",
    ).length,
    uiDriverFamilyAccounting,
    occurrenceAccounting: {
      uiControls: {
        candidates: uiControls.candidates,
        excludedNonActions: uiControls.excludedNonActions,
        finiteVariantInstances: uiControls.finiteVariantInstances,
        inventoried: uiControls.items.length,
      },
      uiDebugSurfaces: {
        candidates: uiDebugSurfaces.candidates,
        finiteVariantInstances: uiDebugSurfaces.finiteVariantInstances,
        inventoried: uiDebugSurfaces.items.length,
      },
    },
    items,
  };
}

export function inventoryJson(inventory: ReleaseSurfaceInventory): string {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

function collectTauriCommands(root: string): ReleaseSurfaceItem[] {
  const source = "src-tauri/src/lib.rs";
  const text = read(root, source);
  const block = text.match(/\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/)?.[1];
  if (!block) throw new Error("Could not locate tauri::generate_handler! command registry");
  return unique(
    block
      .replace(/\/\/.*$/gm, "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.replace(/^crate::(?:[A-Za-z0-9_]+)::/, "")),
  ).map((name) => item("tauri-command", name, source));
}

function collectDebugApiRoutes(root: string): ReleaseSurfaceItem[] {
  const dir = join(root, "src-tauri", "src");
  const rows: ReleaseSurfaceItem[] = [];
  for (const filename of readdirSync(dir).filter((name) => /^debug_api.*\.rs$/.test(name)).sort()) {
    const source = `src-tauri/src/${filename}`;
    const text = read(root, source);
    for (const route of extractDebugApiRoutePairs(text)) {
      rows.push(item("debug-api-route", `${route.method} ${route.path}`, source));
    }
  }
  return dedupeItems(rows);
}


function collectHostMcpTools(root: string): ReleaseSurfaceItem[] {
  const sources = [
    "src-tauri/src/host_mcp/tool_specs_core.rs",
    "src-tauri/src/host_mcp/browser_specs.rs",
    "src-tauri/src/host_mcp/cut_mcp.rs",
    "src-tauri/src/host_mcp/host_specs.rs",
    "src-tauri/src/host_mcp/tool_specs_extended.rs",
  ];
  const rows: ReleaseSurfaceItem[] = [];
  for (const source of sources) {
    const text = read(root, source);
    for (const match of text.matchAll(/"name"\s*:\s*"([A-Za-z][A-Za-z0-9_]*)"/g)) {
      if (match[1]) rows.push(item("host-mcp-tool", match[1], source));
    }
  }
  const advertised = dedupeItems(rows).map((row) => ({ ...row, advertised: true }));
  const dispatchSource = "src-tauri/src/host_mcp.rs";
  const dispatch = read(root, dispatchSource);
  const compatibilityAliases = [
    { name: "session_environment", aliasOf: "environment" },
    { name: "vision_describe_v2", aliasOf: "vision_describe" },
  ];
  for (const alias of compatibilityAliases) {
    if (!dispatch.includes(`"${alias.name}"`)) {
      throw new Error(`Host MCP compatibility alias ${alias.name} is no longer wired in ${dispatchSource}`);
    }
  }
  return [
    ...advertised,
    ...compatibilityAliases.map((alias) => ({
      ...item("host-mcp-tool", alias.name, dispatchSource),
      advertised: false,
      aliasOf: alias.aliasOf,
    })),
  ];
}

function collectBrowserCliCommands(root: string): ReleaseSurfaceItem[] {
  const source = "scripts/shellx-browser-cli.ts";
  const text = read(root, source);
  const start = text.indexOf("switch (parsed.command)");
  const end = text.indexOf("function browserAction", start);
  if (start < 0 || end < 0) throw new Error("Could not locate ShellX Browser CLI command switch");
  const commandBlock = text.slice(start, end);
  const names = ["help", "--help", "-h"];
  for (const match of commandBlock.matchAll(/case\s+["']([^"']+)["']\s*:/g)) {
    if (match[1]) names.push(match[1]);
  }
  return unique(names).map((name) => item("browser-cli-command", name, source));
}

function collectPaletteActions(root: string): ReleaseSurfaceItem[] {
  const source = "src/App.tsx";
  const text = read(root, source);
  const start = text.indexOf("const paletteActions");
  const end = text.indexOf("async function setAutonomyAndPersist", start);
  if (start < 0 || end < 0) throw new Error("Could not locate command-palette action registry");
  return [...text.slice(start, end).matchAll(/id:\s*["'](act-[^"']+)["']/g)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name))
    .map((name) => item("palette-action", name, source));
}

function collectKeyboardShortcuts(root: string): ReleaseSurfaceItem[] {
  const source = "src/lib/shortcuts.ts";
  const text = read(root, source);
  const start = text.indexOf("export const SHORTCUTS");
  const end = text.indexOf("export function isInEditable", start);
  if (start < 0 || end < 0) throw new Error("Could not locate keyboard-shortcut registry");
  return [...text.slice(start, end).matchAll(/\bid:\s*["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name))
    .map((name) => item("keyboard-shortcut", name, source));
}

function collectShellxCommands(root: string): ReleaseSurfaceItem[] {
  const sources = ["src/App.tsx", "src/lib/build-run.ts"];
  const rows: ReleaseSurfaceItem[] = [];
  for (const source of sources) {
    const text = read(root, source);
    for (const match of text.matchAll(/(?:stripped|trimmed)\s*===\s*["'](\/[a-z][a-z-]*)["']/g)) {
      if (match[1]) rows.push(item("shellx-command", match[1], source));
    }
  }
  return dedupeItems(rows);
}

function collectUiControls(root: string): {
  items: ReleaseSurfaceItem[];
  candidates: number;
  excludedNonActions: number;
  finiteVariantInstances: number;
} {
  const files = shippingUiSourceFiles(root);
  const rows: ReleaseSurfaceItem[] = [];
  let candidates = 0;
  let excludedNonActions = 0;
  let finiteVariantInstances = 0;
  for (const absolutePath of files) {
    const source = posix(relative(root, absolutePath));
    const text = readFileSync(absolutePath, "utf8");
    const file = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let ordinal = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(file);
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        if (isInteractiveElement(tag, attributes, file)) {
          ordinal += 1;
          candidates += 1;
          if (isEventShield(tag, attributes, file) || isStaticNonAddressableInput(tag, attributes, file)) {
            excludedNonActions += 1;
          } else {
            const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
            const elementRole = stringAttribute(attributes, "role", file);
            const debugAttribute = attributes.find((attribute) => attribute.name.getText(file) === "data-debug-id");
            const finiteVariants = debugAttribute
              ? finiteMappedAttributeValues(debugAttribute, file, root, source)
              : null;
            if (finiteVariants) finiteVariantInstances += finiteVariants.length;
            for (const finiteVariant of finiteVariants ?? [null]) {
              const locator = controlLocator(node, tag, attributes, file, finiteVariant);
              const name = locator ? `${source}:${locator.value}` : `${source}#${ordinal}:${tag}`;
              rows.push({
                ...occurrenceItem("ui-control", name, source, ordinal),
                line,
                ...(finiteVariant ? { finiteVariant } : {}),
                elementTag: tag,
                ...(elementRole ? { elementRole } : {}),
                ...(tag === "input" ? {
                  inputType: stringAttribute(attributes, "type", file) ?? "text",
                } : {}),
                driverFamily: classifyUiControl(tag, attributes, file),
                eventTrust: "native-required",
                ...(locator ? {
                  selector: locator.value,
                  stableSelector: locator.stable,
                  dynamicSelector: locator.dynamic,
                  selectorStability: locator.stability,
                } : { stableSelector: false, selectorStability: "missing" as const }),
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { items: rows, candidates, excludedNonActions, finiteVariantInstances };
}

function classifyUiControl(
  tag: string,
  attributes: ts.JsxAttribute[],
  file: ts.SourceFile,
): ReleaseUiInteractionFamily {
  const declaredFamily = stringAttribute(attributes, "data-release-driver-family", file);
  if (declaredFamily && RELEASE_UI_INTERACTION_FAMILIES.has(declaredFamily as ReleaseUiInteractionFamily)) {
    return declaredFamily as ReleaseUiInteractionFamily;
  }
  const roleValues = new Set((stringAttribute(attributes, "role", file) ?? "").split("|").filter(Boolean));
  const inputType = tag === "input" ? stringAttribute(attributes, "type", file) ?? "text" : null;
  const hasAttribute = (name: string): boolean => (
    attributes.some((attribute) => attribute.name.getText(file) === name)
  );

  if (tag === "input" && inputType === "file") return "file-picker";
  if (tag === "input" && inputType === "range") return "range";
  if (tag === "textarea") return "text-entry";
  if (
    tag === "input"
    && inputType !== "checkbox"
    && inputType !== "radio"
    && !NON_TEXT_INPUT_TYPES.has(inputType ?? "")
  ) {
    return "text-entry";
  }
  if (roleValues.has("tab") || hasAttribute("aria-selected")) return "selection";
  if (hasAttribute("aria-expanded")) return "disclosure";
  if (
    (tag === "input" && inputType === "checkbox")
    || roleValues.has("checkbox")
    || roleValues.has("switch")
    || hasAttribute("aria-pressed")
    || hasAttribute("aria-checked")
  ) return "toggle";
  if (tag === "select" || (tag === "input" && inputType === "radio") || roleValues.has("radio")) {
    return "choice";
  }
  return "activation";
}

function collectUiDebugSurfaces(root: string): {
  items: ReleaseSurfaceItem[];
  candidates: number;
  finiteVariantInstances: number;
} {
  const files = shippingUiSourceFiles(root);
  const rows: ReleaseSurfaceItem[] = [];
  let candidates = 0;
  let finiteVariantInstances = 0;
  for (const absolutePath of files) {
    const source = posix(relative(root, absolutePath));
    const text = readFileSync(absolutePath, "utf8");
    const file = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const addressedDebugNames = new Set<string>();
    let ordinal = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && ["data-debug-id", "debugId"].includes(node.name.getText(file))) {
        const finiteVariants = finiteMappedAttributeValues(node, file, root, source);
        const values = finiteVariants ?? staticAttributeValues(node);
        if (values.length === 0) {
          ts.forEachChild(node, visit);
          return;
        }
        candidates += 1;
        ordinal += 1;
        if (finiteVariants) finiteVariantInstances += finiteVariants.length;
        for (const name of values) {
          addressedDebugNames.add(name);
          const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
          rows.push(debugSurfaceItem(name, source, ordinal, line, finiteVariants ? name : undefined));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    for (const match of text.matchAll(/\bdebugId\s*:\s*["']([^"']+)["']/g)) {
      if (match[1] && !addressedDebugNames.has(match[1])) {
        candidates += 1;
        ordinal += 1;
        rows.push(debugSurfaceItem(match[1], source, ordinal, lineAt(text, match.index ?? 0)));
      }
    }
  }
  return { items: rows, candidates, finiteVariantInstances };
}

function shippingUiSourceFiles(root: string): string[] {
  return walkFiles(join(root, "src"), (path) => path.endsWith(".tsx"))
    .filter((absolutePath) => !NON_SHIPPING_UI_SOURCES.has(posix(relative(root, absolutePath))));
}

function isInteractiveElement(tag: string, attributes: ts.JsxAttribute[], file: ts.SourceFile): boolean {
  if (/^[A-Z]/.test(tag)) return false;
  if (NATIVE_INTERACTIVE_TAGS.has(tag)) return true;
  const declaredFamily = stringAttribute(attributes, "data-release-driver-family", file);
  if (declaredFamily && RELEASE_UI_INTERACTION_FAMILIES.has(declaredFamily as ReleaseUiInteractionFamily)) return true;
  const role = stringAttribute(attributes, "role", file);
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  return attributes.some((attribute) => attribute.name.getText(file) === "onClick");
}

function isStaticNonAddressableInput(
  tag: string,
  attributes: ts.JsxAttribute[],
  file: ts.SourceFile,
): boolean {
  if (tag !== "input") return false;
  return staticBooleanAttribute(attributes, "readOnly", file) === true
    || staticBooleanAttribute(attributes, "hidden", file) === true
    || stringAttribute(attributes, "type", file) === "hidden";
}

function staticBooleanAttribute(
  attributes: ts.JsxAttribute[],
  name: string,
  file: ts.SourceFile,
): boolean | null {
  const attribute = attributes.find((candidate) => candidate.name.getText(file) === name);
  if (!attribute) return null;
  if (!attribute.initializer) return true;
  if (!ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) return null;
  if (attribute.initializer.expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (attribute.initializer.expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

function isEventShield(tag: string, attributes: ts.JsxAttribute[], file: ts.SourceFile): boolean {
  if (NATIVE_INTERACTIVE_TAGS.has(tag)) return false;
  const role = stringAttribute(attributes, "role", file);
  if (role && INTERACTIVE_ROLES.has(role)) return false;
  const onClick = attributes.find((attribute) => attribute.name.getText(file) === "onClick");
  if (!onClick?.initializer || !ts.isJsxExpression(onClick.initializer) || !onClick.initializer.expression) return false;
  const handler = onClick.initializer.expression;
  if (!ts.isArrowFunction(handler) || handler.parameters.length !== 1) return false;
  const parameter = handler.parameters[0]?.name;
  if (!parameter || !ts.isIdentifier(parameter)) return false;
  const expression = ts.isBlock(handler.body)
    ? handler.body.statements.length === 1 && ts.isExpressionStatement(handler.body.statements[0]!)
      ? handler.body.statements[0]!.expression
      : null
    : handler.body;
  return Boolean(expression && isEventMethodCall(expression, parameter.text, "stopPropagation"));
}

function isEventMethodCall(expression: ts.Expression, parameter: string, method: string): boolean {
  if (!ts.isCallExpression(expression) || expression.arguments.length !== 0) return false;
  const callee = expression.expression;
  return ts.isPropertyAccessExpression(callee)
    && ts.isIdentifier(callee.expression)
    && callee.expression.text === parameter
    && callee.name.text === method;
}

function stringAttribute(attributes: ts.JsxAttribute[], name: string, file: ts.SourceFile): string | null {
  const attribute = attributes.find((candidate) => candidate.name.getText(file) === name);
  return attribute ? staticAttributeValue(attribute) : null;
}

function controlLocator(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  tag: string,
  attributes: ts.JsxAttribute[],
  file: ts.SourceFile,
  finiteDebugValue: string | null = null,
): { value: string; stable: boolean; dynamic: boolean; stability: ReleaseSelectorStability } | null {
  const debugAttribute = attributes.find((attribute) => attribute.name.getText(file) === "data-debug-id");
  if (debugAttribute) {
    const value = finiteDebugValue ?? staticAttributeValue(debugAttribute);
    if (value) return attributeLocator("data-debug-id", value, "durable");
  }
  const releaseControlAttribute = attributes.find(
    (attribute) => attribute.name.getText(file) === "data-release-control",
  );
  if (releaseControlAttribute) {
    const value = staticAttributeValue(releaseControlAttribute);
    if (value) return attributeLocator("data-release-control", value, "durable");
  }
  for (const name of ["id", "aria-label", "name", "title", "placeholder"]) {
    const attribute = attributes.find((candidate) => candidate.name.getText(file) === name);
    const value = attribute ? staticAttributeValue(attribute) : null;
    if (!value) continue;
    const stability: ReleaseSelectorStability = name === "id" || name === "name" ? "durable" : "copy-derived";
    return attributeLocator(name, value, stability);
  }
  const text = directText(node.parent, file);
  if (text) {
    const role = stringAttribute(attributes, "role", file) ?? tag;
    return {
      value: `role=${role};name=${JSON.stringify(text)}`,
      stable: true,
      dynamic: false,
      stability: "copy-derived",
    };
  }
  return null;
}

function attributeLocator(
  name: string,
  value: string,
  baseStability: Exclude<ReleaseSelectorStability, "missing">,
): { value: string; stable: boolean; dynamic: boolean; stability: ReleaseSelectorStability } {
  if (value.includes("|") && !value.includes("*")) {
    const variants = value.split("|").filter(Boolean);
    return {
      value: `:is(${variants.map((variant) => `[${name}=${JSON.stringify(variant)}]`).join(",")})`,
      stable: variants.length > 0,
      dynamic: true,
      stability: variants.length > 0 ? baseStability : "missing",
    };
  }
  if (value.includes("*")) {
    const parts = value.split("*");
    const prefix = parts[0] ?? "";
    const suffix = parts.at(-1) ?? "";
    const selectors = [
      prefix ? `[${name}^=${JSON.stringify(prefix)}]` : "",
      suffix ? `[${name}$=${JSON.stringify(suffix)}]` : "",
    ].filter(Boolean);
    return {
      value: selectors.join("") || `[${name}]`,
      stable: selectors.length > 0,
      dynamic: true,
      stability: selectors.length > 0 ? baseStability : "missing",
    };
  }
  return {
    value: `[${name}=${JSON.stringify(value)}]`,
    stable: true,
    dynamic: false,
    stability: baseStability,
  };
}

function staticAttributeValue(attribute: ts.JsxAttribute): string | null {
  const values = staticAttributeValues(attribute);
  return values.length ? values.sort().join("|") : null;
}

function staticAttributeValues(attribute: ts.JsxAttribute): string[] {
  const initializer = attribute.initializer;
  if (!initializer) return [];
  if (ts.isStringLiteral(initializer)) return [initializer.text];
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return [];
  return staticExpressionValues(initializer.expression);
}

function staticExpressionValues(expression: ts.Expression): string[] {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
  if (ts.isTemplateExpression(expression)) {
    return [`${expression.head.text}${expression.templateSpans.map((span) => `*${span.literal.text}`).join("")}`];
  }
  if (ts.isConditionalExpression(expression)) {
    return unique([...staticExpressionValues(expression.whenTrue), ...staticExpressionValues(expression.whenFalse)]);
  }
  return [];
}

type StaticMapEntry = string | Record<string, string>;

/**
 * Expand controls produced from a finite, statically declared `.map(...)`
 * registry. Runtime-owned rows (tabs, bookmarks, requests, and similar data)
 * deliberately remain wildcard fixture families; authoritative static menus
 * become one release surface per concrete item.
 */
function finiteMappedAttributeValues(
  attribute: ts.JsxAttribute,
  file: ts.SourceFile,
  root: string,
  source: string,
): string[] | null {
  const initializer = attribute.initializer;
  if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression
    || !ts.isTemplateExpression(initializer.expression)) return null;
  const template = initializer.expression;
  let cursor: ts.Node | undefined = attribute;
  let callback: ts.ArrowFunction | ts.FunctionExpression | null = null;
  let mapCall: ts.CallExpression | null = null;
  while (cursor) {
    if ((ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor))
      && ts.isCallExpression(cursor.parent)
      && cursor.parent.arguments.includes(cursor)
      && ts.isPropertyAccessExpression(cursor.parent.expression)
      && cursor.parent.expression.name.text === "map") {
      callback = cursor;
      mapCall = cursor.parent;
      break;
    }
    cursor = cursor.parent;
  }
  const parameter = callback?.parameters[0]?.name;
  if (!callback || !mapCall || !parameter || !ts.isIdentifier(parameter)) return null;
  const mapExpression = mapCall.expression;
  if (!ts.isPropertyAccessExpression(mapExpression)) return null;
  const entries = evaluateStaticMapEntries(mapExpression.expression, file, root, source, new Set());
  if (!entries?.length) return null;
  const accessors = template.templateSpans.map((span) => mappedValueAccessor(span.expression, parameter.text));
  if (accessors.some((accessor) => !accessor)) return null;
  const values: string[] = [];
  for (const entry of entries) {
    let value = template.head.text;
    for (let index = 0; index < template.templateSpans.length; index += 1) {
      const part = accessors[index]!(entry);
      if (part === null) return null;
      value += `${part}${template.templateSpans[index]!.literal.text}`;
    }
    values.push(value);
  }
  return unique(values);
}

function mappedValueAccessor(
  expression: ts.Expression,
  parameter: string,
): ((entry: StaticMapEntry) => string | null) | null {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped) && unwrapped.text === parameter) {
    return (entry) => typeof entry === "string" ? entry : null;
  }
  if (ts.isPropertyAccessExpression(unwrapped)
    && ts.isIdentifier(unwrapExpression(unwrapped.expression))
    && (unwrapExpression(unwrapped.expression) as ts.Identifier).text === parameter) {
    const key = unwrapped.name.text;
    return (entry) => typeof entry === "string" ? null : entry[key] ?? null;
  }
  if (ts.isCallExpression(unwrapped)
    && unwrapped.arguments.length === 0
    && ts.isPropertyAccessExpression(unwrapped.expression)
    && ["toLowerCase", "toUpperCase"].includes(unwrapped.expression.name.text)) {
    const method = unwrapped.expression;
    const base = mappedValueAccessor(method.expression, parameter);
    if (!base) return null;
    return (entry) => {
      const value = base(entry);
      if (value === null) return null;
      return method.name.text === "toLowerCase" ? value.toLowerCase() : value.toUpperCase();
    };
  }
  return null;
}

function evaluateStaticMapEntries(
  expression: ts.Expression,
  file: ts.SourceFile,
  root: string,
  source: string,
  seen: Set<string>,
): StaticMapEntry[] | null {
  const unwrapped = unwrapExpression(expression);
  if (ts.isArrayLiteralExpression(unwrapped)) {
    const entries: StaticMapEntry[] = [];
    for (const element of unwrapped.elements) {
      const value = staticMapEntry(unwrapExpression(element as ts.Expression));
      if (value === null) return null;
      entries.push(value);
    }
    return entries;
  }
  if (ts.isCallExpression(unwrapped) && unwrapped.arguments[0]
    && (ts.isArrowFunction(unwrapped.arguments[0]) || ts.isFunctionExpression(unwrapped.arguments[0]))) {
    const returned = returnedExpression(unwrapped.arguments[0]);
    return returned ? evaluateStaticMapEntries(returned, file, root, source, seen) : null;
  }
  if (!ts.isIdentifier(unwrapped)) return null;
  const key = `${source}:${unwrapped.text}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const local = variableInitializer(file, unwrapped.text);
  if (local) return evaluateStaticMapEntries(local, file, root, source, seen);
  const imported = importedBinding(file, unwrapped.text);
  if (!imported || !imported.module.startsWith(".")) return null;
  const importedSource = resolveImportedSource(root, source, imported.module);
  if (!importedSource) return null;
  const importedFile = ts.createSourceFile(
    importedSource,
    read(root, importedSource),
    ts.ScriptTarget.Latest,
    true,
    importedSource.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const target = variableInitializer(importedFile, imported.exportedName);
  return target ? evaluateStaticMapEntries(target, importedFile, root, importedSource, seen) : null;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function staticMapEntry(expression: ts.Expression): StaticMapEntry | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (!ts.isObjectLiteralExpression(expression)) return null;
  const entry: Record<string, string> = {};
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ? property.name.text
      : null;
    const value = unwrapExpression(property.initializer);
    if (name && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) entry[name] = value.text;
  }
  return Object.keys(entry).length ? entry : null;
}

function returnedExpression(fn: ts.ArrowFunction | ts.FunctionExpression): ts.Expression | null {
  if (!ts.isBlock(fn.body)) return fn.body;
  const returnStatement = fn.body.statements.find(ts.isReturnStatement);
  return returnStatement?.expression ?? null;
}

function variableInitializer(file: ts.SourceFile, name: string): ts.Expression | null {
  let found: ts.Expression | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function importedBinding(
  file: ts.SourceFile,
  localName: string,
): { module: string; exportedName: string } | null {
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const match = bindings.elements.find((element) => element.name.text === localName);
    if (match) return {
      module: statement.moduleSpecifier.text,
      exportedName: match.propertyName?.text ?? match.name.text,
    };
  }
  return null;
}

function resolveImportedSource(root: string, source: string, module: string): string | null {
  const base = resolve(dirname(join(root, source)), module);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate)) return posix(relative(root, candidate));
  }
  return null;
}

function directText(parent: ts.Node, file: ts.SourceFile): string | null {
  if (!ts.isJsxElement(parent)) return null;
  const values: string[] = [];
  for (const child of parent.children) {
    if (ts.isJsxText(child)) {
      const value = child.getText(file).replace(/\s+/g, " ").trim();
      if (value) values.push(value);
    } else if (ts.isJsxExpression(child) && child.expression && ts.isStringLiteral(child.expression)) {
      values.push(child.expression.text);
    }
  }
  const value = values.join(" ").trim();
  return value && value.length <= 120 ? value : null;
}

function item(kind: ReleaseSurfaceKind, name: string, source: string): ReleaseSurfaceItem {
  return {
    id: `${kind}:${name}`,
    kind,
    name,
    source,
    platforms: platformsFor(kind, name),
    delivery: kind === "browser-cli-command" ? "source-package" : "installed-app",
  };
}

function occurrenceItem(
  kind: "ui-control" | "ui-debug-surface",
  name: string,
  source: string,
  occurrence: number,
): ReleaseSurfaceItem {
  return {
    ...item(kind, name, source),
    id: `${kind}:${name}@${source}#${occurrence}`,
    occurrence,
  };
}

function platformsFor(kind: ReleaseSurfaceKind, name: string): ReleasePlatform[] {
  if (kind === "tauri-command" && name.startsWith("desktop_integration_")) return ["windows-installed"];
  if (kind === "ui-control" && (
    name === 'src/components/settings/DesktopTab.tsx:role=button;name="Install"'
    || name === 'src/components/settings/DesktopTab.tsx:role=button;name="Remove"'
  )) return ["windows-installed"];
  return [...ALL_PLATFORMS];
}

function emptyCounts(): Record<ReleaseSurfaceKind, number> {
  return {
    "tauri-command": 0,
    "debug-api-route": 0,
    "host-mcp-tool": 0,
    "browser-cli-command": 0,
    "palette-action": 0,
    "keyboard-shortcut": 0,
    "shellx-command": 0,
    "ui-debug-surface": 0,
    "ui-control": 0,
  };
}

function emptyUiDriverFamilyAccounting(): Record<ReleaseUiDriverFamily, number> {
  return {
    selection: 0,
    disclosure: 0,
    toggle: 0,
    "text-entry": 0,
    choice: 0,
    range: 0,
    "file-picker": 0,
    activation: 0,
    "static-marker": 0,
    "dynamic-marker": 0,
  };
}

function debugSurfaceItem(
  name: string,
  source: string,
  occurrence: number,
  line: number,
  finiteVariant?: string,
): ReleaseSurfaceItem {
  const locator = attributeLocator("data-debug-id", name, "durable");
  return {
    ...occurrenceItem("ui-debug-surface", name, source, occurrence),
    line,
    ...(finiteVariant ? { finiteVariant } : {}),
    selector: locator.value,
    stableSelector: locator.stable,
    dynamicSelector: locator.dynamic,
    selectorStability: locator.stability,
    driverFamily: locator.dynamic ? "dynamic-marker" : "static-marker",
    eventTrust: "not-applicable",
  };
}

function dedupeItems(rows: ReleaseSurfaceItem[]): ReleaseSurfaceItem[] {
  const byId = new Map<string, ReleaseSurfaceItem>();
  for (const row of rows) {
    const existing = byId.get(row.id);
    if (!existing) byId.set(row.id, row);
  }
  return [...byId.values()];
}

function assertUniqueIds(rows: ReleaseSurfaceItem[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error(`Duplicate release surface id: ${row.id}`);
    seen.add(row.id);
  }
}

function walkFiles(dir: string, accept: (path: string) => boolean): string[] {
  const rows: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) rows.push(...walkFiles(path, accept));
    else if (accept(path)) rows.push(path);
  }
  return rows.sort();
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function posix(path: string): string {
  return path.split("\\").join("/");
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}
