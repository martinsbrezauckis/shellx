import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { readAppStyles } from "./lib/app-styles";

function read(path: string): string {
  return readFileSync(join(cwd(), path), "utf8");
}

function assertIncludes(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`missing ${label}: ${needle}`);
  }
}

const settings = read("src/lib/settings.ts");
assertIncludes(settings, 'export type ThemeMode = "black" | "black_warm" | "bright";', "bright theme enum");
assertIncludes(
  settings,
  'themeValue === "black_warm" || themeValue === "black" || themeValue === "bright"',
  "bright theme normalization",
);

const generalTab = read("src/components/settings/GeneralTab.tsx");
assertIncludes(generalTab, 's.theme === "bright"', "bright settings active state");
assertIncludes(generalTab, 'onPatch({ theme: "bright" })', "bright settings patch");
assertIncludes(generalTab, "Bright", "bright settings label");

const header = read("src/components/Header.tsx");
assertIncludes(header, "theme?: ThemeMode;", "header theme prop");
assertIncludes(header, "onThemeToggle?: () => void;", "header theme toggle prop");
assertIncludes(header, 'data-debug-id="header-theme-toggle"', "header theme debug id");
assertIncludes(header, 'theme === "bright" ? "sun" : "moon"', "header theme icon switch");

const icons = read("src/components/icons.tsx");
assertIncludes(icons, "Moon,", "moon icon import");
assertIncludes(icons, "Sun,", "sun icon import");
assertIncludes(icons, '| "moon"', "moon icon name");
assertIncludes(icons, '| "sun"', "sun icon name");

const app = read("src/App.tsx");
assertIncludes(app, "function handleThemeToggle()", "theme toggle handler");
assertIncludes(app, 'theme: settings.theme === "bright" ? "black" : "bright"', "theme toggle persistence target");
assertIncludes(app, "onThemeToggle={handleThemeToggle}", "header theme handler wiring");

const css = readAppStyles();
const browserLayoutCss = read("src/browser/browserLayout.css");
const browserCss = read("src/browser/browserShell.css");
const tokensCss = read("src/styles/tokens.css");
const interactionCss = read("src/styles/interactionAccessibility.css");
assertIncludes(css, '[data-theme="bright"]', "bright CSS theme block");
assertIncludes(css, "color-scheme: light;", "bright color scheme");
assertIncludes(css, ".hdr-theme-toggle.active", "header bright active style");
assertIncludes(browserCss, "--shellx-browser-viewport-card: rgba(255, 255, 255, 0.94)", "light Browser placeholder surface");
assertIncludes(browserCss, "background: var(--shellx-browser-viewport-card)", "Browser placeholder token use");
assertIncludes(browserCss, "color: var(--shellx-browser-ref-ink)", "Browser reference contrast token");
assertIncludes(browserCss, "var(--shellx-browser-right-sidebar-width, 360px)", "Browser resizable right sidebar width");
assertIncludes(browserCss, "var(--shellx-browser-left-sidecar-width, 312px)", "Browser left sidecar width");
assertIncludes(browserCss, "grid-template-rows: minmax(0, 220px) minmax(320px, 1fr) minmax(0, 220px)", "Browser narrow three-surface layout");
assertIncludes(browserCss, "overflow: auto;", "Browser narrow layout scroll containment");
assertIncludes(interactionCss, "@media (prefers-reduced-motion: reduce)", "main renderer reduced-motion preference");
assertIncludes(interactionCss, "animation-iteration-count: 1 !important", "bounded reduced-motion animation iterations");

for (const foreground of ["--ink-3", "--ink-4"]) {
  for (const background of ["--bg", "--surface", "--surface-2", "--surface-3"]) {
    const ratio = contrastRatio(cssHexToken(tokensCss, foreground), cssHexToken(tokensCss, background));
    if (ratio < 4.5) {
      throw new Error(`${foreground} on ${background} contrast ${ratio.toFixed(2)} is below WCAG AA 4.5:1`);
    }
  }
}

const browserThemeBlocks = [
  {
    label: "Browser light",
    baseBlock: cssSelectorBlock(browserLayoutCss, '.shellx-browser-app[data-color-mode="light"]'),
    refinementBlock: cssSelectorBlock(browserCss, '.shellx-browser-app[data-color-mode="light"]'),
  },
  {
    label: "Browser dark",
    baseBlock: cssSelectorBlock(browserLayoutCss, '.shellx-browser-app[data-color-mode="dark"]'),
    refinementBlock: cssSelectorBlock(browserCss, '.shellx-browser-app[data-color-mode="dark"]'),
  },
  {
    label: "Browser system light",
    baseBlock: cssSelectorBlock(browserLayoutCss, '.shellx-browser-app[data-color-mode="system"]', 0),
    refinementBlock: cssSelectorBlock(browserCss, '.shellx-browser-app[data-color-mode="system"]', 0),
  },
  {
    label: "Browser system dark",
    baseBlock: cssSelectorBlock(browserLayoutCss, '.shellx-browser-app[data-color-mode="system"]', 1),
    refinementBlock: cssSelectorBlock(browserCss, '.shellx-browser-app[data-color-mode="system"]', 1),
  },
];
for (const { label, baseBlock, refinementBlock } of browserThemeBlocks) {
  for (const foreground of ["--ink-3", "--ink-4"]) {
    for (const background of ["--bg", "--surface", "--surface-2", "--surface-3"]) {
      const backgroundValue = cssHexToken(baseBlock, background);
      const baseRatio = contrastRatio(cssHexToken(baseBlock, foreground), backgroundValue);
      const effectiveRatio = contrastRatio(cssHexToken(refinementBlock, foreground), backgroundValue);
      if (baseRatio < 4.5 || effectiveRatio < 4.5) {
        throw new Error(
          `${label} ${foreground} on ${background} contrast is below WCAG AA 4.5:1 `
          + `(base ${baseRatio.toFixed(2)}, effective ${effectiveRatio.toFixed(2)})`,
        );
      }
    }
  }
}

console.log("shellx theme wiring test passed");

function cssHexToken(source: string, name: string): string {
  const match = source.match(new RegExp(`${name.replace("-", "\\-")}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) throw new Error(`missing hex token ${name}`);
  return match[1];
}

function cssSelectorBlock(source: string, selector: string, occurrence = 0): string {
  const marker = `${selector} {`;
  let start = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    start = source.indexOf(marker, start + 1);
    if (start < 0) throw new Error(`missing CSS selector occurrence ${occurrence}: ${selector}`);
  }
  const bodyStart = start + marker.length;
  const bodyEnd = source.indexOf("}", bodyStart);
  if (bodyEnd < 0) throw new Error(`unterminated CSS selector: ${selector}`);
  return source.slice(bodyStart, bodyEnd);
}

function contrastRatio(left: string, right: string): number {
  const [lighter, darker] = [relativeLuminance(left), relativeLuminance(right)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}
