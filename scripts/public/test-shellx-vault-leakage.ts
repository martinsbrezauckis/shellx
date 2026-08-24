import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const markers = [
  "SXV_TEST_SECRET_ABC",
  "SXV_BROWSER_SECRET_123",
  "SXV_INTERNAL_ONLY",
];
const allowed = new Set([
  "src-tauri/tests/shellx_vault_integration.rs",
  "src-tauri/tests/shellx_browser.rs",
  "scripts/public/test-shellx-vault-leakage.ts",
]);
const roots = ["src-tauri/src", "src-tauri/tests", "src", "scripts", "docs", "shellx-browser"];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (["target", "node_modules", ".git"].includes(name)) continue;
      out.push(...walk(path));
    } else {
      out.push(path);
    }
  }
  return out;
}

for (const file of roots.flatMap((scope) => walk(join(root, scope)))) {
  const rel = file.slice(root.length + 1).replaceAll("\\", "/");
  if (allowed.has(rel)) continue;
  const body = readFileSync(file, "utf8");
  for (const marker of markers) {
    if (body.includes(marker)) {
      throw new Error(`${rel} leaks test marker ${marker}`);
    }
  }
}

console.log("ShellX Vault leakage scan ok");
