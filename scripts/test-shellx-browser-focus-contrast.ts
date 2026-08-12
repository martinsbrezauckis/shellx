import { readFileSync } from "node:fs";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function cssHexToken(block: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`${escaped}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) throw new Error(`missing hex token ${name}`);
  return match[1];
}

function cssSelectorBlock(sourceText: string, selector: string, occurrence = 0): string {
  const marker = `${selector} {`;
  let start = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    start = sourceText.indexOf(marker, start + 1);
    if (start < 0) throw new Error(`missing CSS selector occurrence ${occurrence}: ${selector}`);
  }
  const bodyStart = start + marker.length;
  const bodyEnd = sourceText.indexOf("}", bodyStart);
  if (bodyEnd < 0) throw new Error(`unterminated CSS selector: ${selector}`);
  return sourceText.slice(bodyStart, bodyEnd);
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

console.log("\n=== ShellX Browser focus and informational contrast ===");

const shellCss = source("src/browser/browserShell.css");
const layoutCss = source("src/browser/browserLayout.css");
const workspaceCss = source("src/browser/browserWorkspace.css");
const evidenceCss = source("src/browser/browserEvidence.css");
const rootTokens = cssSelectorBlock(shellCss, ".shellx-browser-app");
const lightTokens = cssSelectorBlock(shellCss, '.shellx-browser-app[data-color-mode="light"]');
const systemLightTokens = cssSelectorBlock(shellCss, '.shellx-browser-app[data-color-mode="system"]', 0);
const lightSurfaces = cssSelectorBlock(layoutCss, '.shellx-browser-app[data-color-mode="light"]');
const darkSurfaces = cssSelectorBlock(layoutCss, '.shellx-browser-app[data-color-mode="dark"]');
const systemLightSurfaces = cssSelectorBlock(layoutCss, '.shellx-browser-app[data-color-mode="system"]', 0);
const systemDarkSurfaces = cssSelectorBlock(layoutCss, '.shellx-browser-app[data-color-mode="system"]', 1);

for (const { label, tokens, surfaces } of [
  { label: "light", tokens: lightTokens, surfaces: lightSurfaces },
  { label: "dark", tokens: rootTokens, surfaces: darkSurfaces },
  { label: "system light", tokens: systemLightTokens, surfaces: systemLightSurfaces },
  { label: "system dark", tokens: rootTokens, surfaces: systemDarkSurfaces },
]) {
  const focus = cssHexToken(tokens, "--shellx-browser-focus-ring");
  const info = cssHexToken(tokens, "--shellx-browser-info-ink");
  const surface = cssHexToken(surfaces, "--surface");
  const surface2 = cssHexToken(surfaces, "--surface-2");
  for (const [role, foreground, background] of [
    ["focus ring on address surface", focus, surface],
    ["focus ring on bookmark and Teach surface", focus, surface2],
    ["informational edge on status surface", info, surface2],
  ] as const) {
    const ratio = contrastRatio(foreground, background);
    assert(ratio >= 3, `${label} ${role} contrast ${ratio.toFixed(2)} meets the 3:1 non-text threshold`);
  }
}

assert(
  shellCss.includes("--shellx-browser-focus-ring:")
    && shellCss.includes("--shellx-browser-info-ink:")
    && lightTokens.includes("--shellx-browser-focus-ring: #245ca6")
    && systemLightTokens.includes("--shellx-browser-info-ink: #245ca6"),
  "defines Browser-local focus and informational tokens for explicit and system light modes",
);
assert(
  layoutCss.includes("accent-color: var(--shellx-browser-focus-ring)")
    && layoutCss.includes(".shellx-browser-address-shell:focus-within")
    && layoutCss.includes("box-shadow: 0 0 0 2px var(--shellx-browser-focus-ring)")
    && layoutCss.includes(".shellx-browser-history-actions .shellx-browser-utility-row:focus-visible")
    && layoutCss.includes("outline: 2px solid var(--shellx-browser-focus-ring)")
    && workspaceCss.includes(".shellx-browser-bookmark-row-main:focus-within")
    && workspaceCss.includes("border-color: var(--shellx-browser-focus-ring)")
    && evidenceCss.includes(".shellx-browser-developer-actions .shellx-browser-secondary:focus-visible")
    && evidenceCss.includes(".shellx-browser-teach-section :is(button, textarea, input, select):focus-visible")
    && evidenceCss.includes("outline: 2px solid var(--shellx-browser-focus-ring)"),
  "routes Browser keyboard and editable-control focus through the semantic focus token",
);
assert(
  evidenceCss.includes(".shellx-browser-developer-state")
    && evidenceCss.includes("border-left: 3px solid var(--shellx-browser-info-ink)")
    && evidenceCss.includes("severity-info { border-left-color: var(--shellx-browser-info-ink); }")
    && evidenceCss.includes(".shellx-browser-teach-state.running")
    && evidenceCss.includes("border-left-color: var(--shellx-browser-info-ink)")
    && layoutCss.includes(".shellx-browser-history-clear-status")
    && layoutCss.includes("border-left: 2px solid var(--shellx-browser-info-ink)"),
  "uses informational ink for neutral Developer, Teach, and History states",
);
assert(
  evidenceCss.includes("border-left-color: var(--warn)")
    && evidenceCss.includes("border-left-color: var(--err)")
    && evidenceCss.includes("border-left-color: var(--ok)")
    && layoutCss.includes(".shellx-browser-history-clear-status.error")
    && layoutCss.includes("border-left-color: var(--err)")
    && layoutCss.includes(".shellx-browser-download-icon-status.pending")
    && layoutCss.includes("var(--warn)"),
  "retains warning, error, and success semantics rather than repurposing focus or information ink",
);
assert(
  ![layoutCss, workspaceCss, evidenceCss].some((stylesheet) => stylesheet.includes("var(--accent)")),
  "does not leave global white accent consumers in Browser focus or informational styles",
);

console.log("ShellX Browser focus and informational contrast checks passed");
