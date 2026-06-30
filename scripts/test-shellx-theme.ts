import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

function read(path: string): string {
  return readFileSync(join(cwd(), path), "utf8");
}

function assertIncludes(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`missing ${label}: ${needle}`);
  }
}

const settings = read("src/components/Settings.tsx");
assertIncludes(settings, 'export type ThemeMode = "black" | "black_warm" | "bright";', "bright theme enum");
assertIncludes(settings, 'obj.theme === "black_warm" || obj.theme === "black" || obj.theme === "bright"', "bright theme normalization");

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

const css = read("src/App.css");
assertIncludes(css, '[data-theme="bright"]', "bright CSS theme block");
assertIncludes(css, "color-scheme: light;", "bright color scheme");
assertIncludes(css, ".hdr-theme-toggle.active", "header bright active style");

console.log("shellx theme wiring test passed");
