import { readFileSync } from "node:fs";

export const APP_STYLE_PATHS = [
  "src/styles/app-core.css",
  "src/styles/app-workspace.css",
  "src/styles/app-settings.css",
  "src/styles/app-tools.css",
  "src/styles/app-navigation.css",
  "src/styles/app-polish.css",
] as const;

export function readAppStyles(): string {
  return APP_STYLE_PATHS.map((path) => readFileSync(path, "utf8")).join("\n");
}
