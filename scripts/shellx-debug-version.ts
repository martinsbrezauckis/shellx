import { readFileSync } from "node:fs";
import { join } from "node:path";

type DebugHealth = {
  appVersion?: unknown;
  app_version?: unknown;
};

function expectedShellxVersion(): string {
  const override = process.env.SHELLX_EXPECTED_VERSION?.trim();
  if (override) return override;
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || !pkg.version.trim()) {
    throw new Error("package.json does not expose a valid ShellX version");
  }
  return pkg.version;
}

export async function assertDebugHealthVersion(res: Response, source: string): Promise<void> {
  const expected = expectedShellxVersion();
  let health: DebugHealth;
  try {
    health = await res.clone().json() as DebugHealth;
  } catch (error) {
    throw new Error(`${source}: /health did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const actual = typeof health.appVersion === "string"
    ? health.appVersion
    : typeof health.app_version === "string"
      ? health.app_version
      : null;

  if (!actual) {
    throw new Error(`${source}: /health missing appVersion; installed ShellX is too old for release UI evidence`);
  }
  if (actual !== expected) {
    throw new Error(`${source}: /health appVersion ${actual} does not match package.json ${expected}`);
  }
}
