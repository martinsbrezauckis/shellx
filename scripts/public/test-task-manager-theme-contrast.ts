import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readAppStyles } from "./lib/app-styles";

const root = resolve(import.meta.dirname, "../..");
const taskCss = readFileSync(resolve(root, "src/components/TaskManager.css"), "utf8");
const tokens = readFileSync(resolve(root, "src/styles/tokens.css"), "utf8");
const appCss = readAppStyles();

for (const declaration of [
  "--task-manager-primary-bg: var(--orange);",
  "--task-manager-primary-hover-bg: var(--orange-soft);",
  "--task-manager-primary-ink: var(--surface);",
  "--task-manager-focus-ring: var(--orange-soft);",
  "--task-manager-primary-hover-bg: var(--orange);",
  "--task-manager-focus-ring: var(--orange);",
  "outline: 2px solid var(--task-manager-focus-ring);",
]) assert(taskCss.includes(declaration), `Task Manager must retain local semantic token ${declaration}`);

const primaryRule = /\.task-manager-action-button\.is-primary \{([^}]+)\}/.exec(taskCss)?.[1] ?? "";
assert(primaryRule.includes("var(--task-manager-primary-ink)"));
assert(primaryRule.includes("var(--task-manager-primary-bg)"));
assert(!primaryRule.includes("var(--accent)"), "Task Manager primary actions must not inherit incompatible global accent contrast");

const dark = valuesFrom(tokens);
const bright = valuesFrom(/\[data-theme="bright"\]\s*\{([\s\S]*?)\n\}/.exec(appCss)?.[1] ?? "");

assertContrast("dark primary text", dark.surface, dark.orange, 4.5);
assertContrast("dark primary hover text", dark.surface, dark.orangeSoft, 4.5);
assertContrast("dark focus", dark.surface, dark.orangeSoft, 3);
assertContrast("bright primary text", bright.surface, bright.orange, 4.5);
assertContrast("bright primary hover text", bright.surface, bright.orange, 4.5);
assertContrast("bright focus", bright.surface, bright.orange, 3);

console.log("Task Manager theme contrast passed: local primary/focus tokens avoid global accent, with >=4.5:1 text and >=3:1 focus contrast in dark and bright themes.");

function valuesFrom(source: string): { surface: string; orange: string; orangeSoft: string } {
  return {
    surface: declaration(source, "surface"),
    orange: declaration(source, "orange"),
    orangeSoft: declaration(source, "orange-soft"),
  };
}

function declaration(source: string, name: string): string {
  const value = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(source)?.[1];
  assert(value, `Missing literal --${name} colour token`);
  return value;
}

function assertContrast(label: string, first: string, second: string, minimum: number): void {
  const ratio = contrastRatio(first, second);
  assert(ratio >= minimum, `${label} contrast ${ratio.toFixed(2)}:1 is below ${minimum}:1`);
}

function contrastRatio(first: string, second: string): number {
  const one = luminance(first);
  const two = luminance(second);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}
