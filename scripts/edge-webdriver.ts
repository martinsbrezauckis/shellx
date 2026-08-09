import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export type EdgeDriverSource = "configured" | "cache" | "download";

export type EdgeDriverResolution = {
  browserVersion: string;
  driverVersion: string;
  path: string;
  source: EdgeDriverSource;
};

export type EdgeDriverDependencies = {
  exists(path: string): boolean;
  readVersion(path: string): string;
  install(input: { browserVersion: string; downloadUrl: string; targetPath: string }): void;
};

export type EnsureEdgeDriverOptions = {
  autoInstall: boolean;
  browserVersion: string;
  cachePath: string;
  configuredPath?: string;
  dependencies?: EdgeDriverDependencies;
};

const VERSION_PATTERN = /\b(\d+\.\d+\.\d+\.\d+)\b/;

export function parseFourPartVersion(value: string, label: string): string {
  const version = value.match(VERSION_PATTERN)?.[1];
  if (!version) throw new Error(`${label} did not report a four-part version: ${value.trim() || "<empty>"}`);
  return version;
}

export function edgeDriverIsCompatible(browserVersion: string, driverVersion: string): boolean {
  const browser = parseFourPartVersion(browserVersion, "Microsoft Edge version").split(".");
  const driver = parseFourPartVersion(driverVersion, "Microsoft Edge WebDriver version").split(".");
  return browser.slice(0, 3).join(".") === driver.slice(0, 3).join(".");
}

export function edgeDriverDownloadUrl(browserVersion: string): string {
  const version = parseFourPartVersion(browserVersion, "Microsoft Edge version");
  return `https://msedgedriver.microsoft.com/${version}/edgedriver_win64.zip`;
}

export function edgeDriverCachePath(userProfile: string, browserVersion: string): string {
  const version = parseFourPartVersion(browserVersion, "Microsoft Edge version");
  return winJoin(userProfile, ".shellx", "tools", "msedgedriver", version, "win64", "msedgedriver.exe");
}

export function installedMicrosoftEdgeVersion(): string {
  return parseFourPartVersion(runPowerShell([
    "$v=(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Edge\\BLBeacon' -ErrorAction SilentlyContinue).version",
    "if (-not $v) { $v=(Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Edge\\BLBeacon' -ErrorAction SilentlyContinue).version }",
    "if (-not $v) { throw 'Microsoft Edge version is unavailable from the installed BLBeacon registry key' }",
    "Write-Output $v",
  ].join("; ")), "installed Microsoft Edge version");
}

export function ensureEdgeDriver(options: EnsureEdgeDriverOptions): EdgeDriverResolution {
  const dependencies = options.dependencies ?? defaultDependencies;
  const browserVersion = parseFourPartVersion(options.browserVersion, "Microsoft Edge version");
  const configuredPath = options.configuredPath?.trim();

  if (configuredPath) {
    if (!dependencies.exists(configuredPath)) {
      throw new Error(`Configured Microsoft Edge WebDriver does not exist: ${configuredPath}`);
    }
    return inspectCandidate(dependencies, browserVersion, configuredPath, "configured");
  }

  if (dependencies.exists(options.cachePath)) {
    try {
      return inspectCandidate(dependencies, browserVersion, options.cachePath, "cache");
    } catch (error) {
      if (!options.autoInstall) throw error;
    }
  } else if (!options.autoInstall) {
    throw new Error(
      `Microsoft Edge WebDriver is not cached at ${options.cachePath}. `
      + "Run again with SHELLX_WEBDRIVER_AUTO_INSTALL=1 or set SHELLX_WEBDRIVER_NATIVE_DRIVER.",
    );
  }

  const downloadUrl = edgeDriverDownloadUrl(browserVersion);
  dependencies.install({ browserVersion, downloadUrl, targetPath: options.cachePath });
  if (!dependencies.exists(options.cachePath)) {
    throw new Error(`Microsoft Edge WebDriver acquisition completed without creating ${options.cachePath}`);
  }
  return inspectCandidate(dependencies, browserVersion, options.cachePath, "download");
}

function inspectCandidate(
  dependencies: EdgeDriverDependencies,
  browserVersion: string,
  path: string,
  source: EdgeDriverSource,
): EdgeDriverResolution {
  const driverVersion = parseFourPartVersion(dependencies.readVersion(path), "Microsoft Edge WebDriver");
  if (!edgeDriverIsCompatible(browserVersion, driverVersion)) {
    throw new Error(
      `Microsoft Edge ${browserVersion} is incompatible with WebDriver ${driverVersion} at ${path}; `
      + "the first three version components must match.",
    );
  }
  return { browserVersion, driverVersion, path, source };
}

function winJoin(...parts: string[]): string {
  const [first, ...rest] = parts;
  return [first, ...rest]
    .filter(Boolean)
    .join("\\")
    .replace(/[\\/]+/g, "\\");
}

function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runPowerShell(script: string): string {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || result.error?.message || "PowerShell failed").trim());
  }
  return result.stdout.trim();
}

const defaultDependencies: EdgeDriverDependencies = {
  exists(path) {
    if (process.platform === "win32") return existsSync(path);
    const output = runPowerShell(
      `if (Test-Path -LiteralPath ${powerShellLiteral(path)}) { 'yes' } else { 'no' }`,
    );
    return output.replace(/\r?\n/g, "").trim() === "yes";
  },
  readVersion(path) {
    return runPowerShell(`& ${powerShellLiteral(path)} --version`);
  },
  install({ downloadUrl, targetPath }) {
    runPowerShell([
      "$ErrorActionPreference = 'Stop'",
      `$target = ${powerShellLiteral(targetPath)}`,
      "$targetDir = Split-Path -Parent $target",
      "$staging = \"$targetDir.staging-$PID\"",
      "$zip = \"$staging.zip\"",
      "Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue",
      "Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue",
      "New-Item -ItemType Directory -Path $staging -Force | Out-Null",
      "try {",
      `  Invoke-WebRequest -UseBasicParsing -Uri ${powerShellLiteral(downloadUrl)} -OutFile $zip`,
      "  Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force",
      "  $driver = Get-ChildItem -LiteralPath $staging -Filter 'msedgedriver.exe' -File -Recurse | Select-Object -First 1",
      "  if (-not $driver) { throw 'Downloaded archive does not contain msedgedriver.exe' }",
      "  New-Item -ItemType Directory -Path $targetDir -Force | Out-Null",
      "  Copy-Item -LiteralPath $driver.FullName -Destination $target -Force",
      "} finally {",
      "  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue",
      "  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue",
      "}",
    ].join("\n"));
  },
};
