import { existsSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

type WebDriverJson = {
  value?: unknown;
  sessionId?: string;
};

type Platform = "linux" | "windows";

const args = new Set(process.argv.slice(2));
const platform = resolvePlatform();
const port = Number(process.env.SHELLX_WEBDRIVER_PORT || randomPort());
const nativePort = Number(process.env.SHELLX_WEBDRIVER_NATIVE_PORT || randomPort());
const driverUrl = `http://127.0.0.1:${port}`;
const evidenceDir = process.env.SHELLX_WEBDRIVER_EVIDENCE_DIR?.trim()
  || mkdtempSync(join(tmpdir(), "shellx-tauri-webdriver-"));
const screenshotPath = join(evidenceDir, `shellx-webdriver-${platform}.png`);

function assert(condition: unknown, label: string): void {
  if (!condition) throw new Error(label);
  console.log(`  ✓ ${label}`);
}

function resolvePlatform(): Platform {
  const value = (process.env.SHELLX_WEBDRIVER_PLATFORM || "").trim().toLowerCase();
  if (value === "windows" || args.has("--windows")) return "windows";
  if (value === "linux" || args.has("--linux")) return "linux";
  return process.platform === "win32" ? "windows" : "linux";
}

function run(command: string, commandArgs: string[]): string {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function maybeRun(command: string, commandArgs: string[]): string | null {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function commandExists(command: string): boolean {
  if (process.platform === "win32") {
    return spawnSync("where.exe", [command]).status === 0;
  }
  return spawnSync("bash", ["-lc", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`]).status === 0;
}

function randomPort(): number {
  return 20_000 + Math.floor(Math.random() * 20_000);
}

function winJoin(...parts: string[]): string {
  const [first, ...rest] = parts;
  return [first, ...rest]
    .filter(Boolean)
    .join("\\")
    .replace(/[\\/]+/g, "\\");
}

function windowsEnv(name: string): string {
  const direct = process.env[name]?.trim();
  if (direct && process.platform === "win32") return direct;
  const fromPowerShell = maybeRun("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Write-Output $env:${name}`,
  ]);
  if (!fromPowerShell) throw new Error(`Unable to resolve Windows %${name}%`);
  return fromPowerShell.replace(/\r?\n/g, "").trim();
}

function windowsPathExists(path: string): boolean {
  if (process.platform === "win32") return existsSync(path);
  const escaped = path.replace(/'/g, "''");
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `if (Test-Path '${escaped}') { exit 0 } else { exit 1 }`,
  ]);
  return result.status === 0;
}

function windowsToWslPath(path: string): string {
  if (process.platform === "win32") return path;
  return run("wslpath", ["-u", path]);
}

function chooseExistingWindowsPath(candidates: string[]): string {
  const found = candidates.find(windowsPathExists);
  if (!found) throw new Error(`None of the Windows path candidates exist: ${candidates.join("; ")}`);
  return found;
}

function resolveLinuxConfig(): { tauriDriver: string; application: string; nativeDriver?: string } {
  const tauriDriver = process.env.SHELLX_WEBDRIVER_TAURI_DRIVER?.trim()
    || join(process.env.HOME || "", ".cargo", "bin", "tauri-driver");
  const application = process.env.SHELLX_WEBDRIVER_APP?.trim()
    || resolve("src-tauri", "target", "release", "shellx");
  const nativeDriver = process.env.SHELLX_WEBDRIVER_NATIVE_DRIVER?.trim() || undefined;
  return { tauriDriver, application, nativeDriver };
}

function resolveWindowsConfig(): { tauriDriver: string; application: string; nativeDriver: string } {
  const userProfile = windowsEnv("USERPROFILE");
  const localAppData = windowsEnv("LOCALAPPDATA");
  const edgeVersion = process.env.SHELLX_WEBDRIVER_EDGE_VERSION?.trim()
    || maybeRun("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$v=(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Edge\\BLBeacon' -ErrorAction SilentlyContinue).version; if (-not $v) { $v=(Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Edge\\BLBeacon' -ErrorAction SilentlyContinue).version }; Write-Output $v",
    ])?.replace(/\r?\n/g, "").trim();
  if (!edgeVersion) throw new Error("Unable to resolve Microsoft Edge version for msedgedriver path");

  const tauriDriverWin = process.env.SHELLX_WEBDRIVER_TAURI_DRIVER?.trim()
    || chooseExistingWindowsPath([
      winJoin(userProfile, ".cargo", "bin", "tauri-driver.exe"),
    ]);
  const nativeDriverWin = process.env.SHELLX_WEBDRIVER_NATIVE_DRIVER?.trim()
    || chooseExistingWindowsPath([
      winJoin(userProfile, ".shellx", "tools", "msedgedriver", edgeVersion, "win64", "msedgedriver.exe"),
    ]);
  const application = process.env.SHELLX_WEBDRIVER_APP?.trim()
    || chooseExistingWindowsPath([
      winJoin(userProfile, "shellx-build", "shellx", "src-tauri", "target", "release", "shellx.exe"),
      winJoin(localAppData, "shellX", "shellx.exe"),
      winJoin(localAppData, "shellx", "shellx.exe"),
    ]);
  const tauriDriver = process.platform === "win32" ? tauriDriverWin : windowsToWslPath(tauriDriverWin);
  return { tauriDriver, nativeDriver: nativeDriverWin, application };
}

function closeExistingWindowsShellX(): void {
  if (!args.has("--close-existing") && process.env.SHELLX_WEBDRIVER_CLOSE_EXISTING !== "1") return;
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'shellx.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Failed to close existing Windows ShellX processes: ${result.stderr || result.stdout}`);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function webdriverRequest(method: string, path: string, body?: unknown): Promise<WebDriverJson> {
  const res = await fetch(`${driverUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) as WebDriverJson : {};
  if (!res.ok) throw new Error(`${method} ${path} failed ${res.status}: ${text.slice(0, 2000)}`);
  return json;
}

async function waitForDriver(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const status = await webdriverRequest("GET", "/status");
      if (status.value) return;
    } catch {
      // The native driver may take a moment to bind.
    }
    await sleep(250);
  }
  throw new Error(`tauri-driver did not become ready on ${driverUrl}`);
}

async function quitSession(sessionId: string): Promise<void> {
  try {
    await webdriverRequest("DELETE", `/session/${sessionId}`);
  } catch (err) {
    console.warn(`  ! session cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function launchDriver(config: { tauriDriver: string; nativeDriver?: string }): ChildProcess {
  const driverArgs = ["--port", String(port), "--native-port", String(nativePort)];
  if (config.nativeDriver) driverArgs.push("--native-driver", config.nativeDriver);
  const child = spawn(config.tauriDriver, driverArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[tauri-driver] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[tauri-driver] ${chunk}`));
  child.on("error", (error) => {
    throw error;
  });
  return child;
}

async function main(): Promise<void> {
  const config = platform === "windows" ? resolveWindowsConfig() : resolveLinuxConfig();
  console.log(`\n=== Tauri WebDriver smoke (${platform}) ===`);
  console.log(`driver=${config.tauriDriver}`);
  console.log(`app=${config.application}`);
  console.log(`port=${port}`);
  console.log(`nativePort=${nativePort}`);
  if (config.nativeDriver) console.log(`nativeDriver=${config.nativeDriver}`);
  assert(existsSync(config.tauriDriver), "tauri-driver binary exists");
  if (platform === "linux") {
    assert(existsSync(config.application), "Linux ShellX binary exists");
    if (!config.nativeDriver) assert(commandExists("WebKitWebDriver"), "WebKitWebDriver is available");
  } else {
    const nativeDriver = config.nativeDriver;
    assert(windowsPathExists(config.application), "Windows ShellX binary exists");
    assert(nativeDriver && windowsPathExists(nativeDriver), "Windows msedgedriver exists");
    closeExistingWindowsShellX();
  }

  const child = launchDriver(config);
  let sessionId: string | null = null;
  try {
    await waitForDriver();
    const session = await webdriverRequest("POST", "/session", {
      capabilities: {
        alwaysMatch: {
          "tauri:options": {
            application: config.application,
          },
        },
      },
    });
    sessionId = String((session.value as { sessionId?: string } | undefined)?.sessionId || session.sessionId || "");
    assert(sessionId, "WebDriver session is created");
    await sleep(4_000);

    const title = await webdriverRequest("GET", `/session/${sessionId}/title`);
    assert(title.value === "shellX", "window title is shellX");

    const source = await webdriverRequest("GET", `/session/${sessionId}/source`);
    const sourceText = String(source.value || "");
    assert(sourceText.length > 1_000, "page source is populated");

    const body = await webdriverRequest("POST", `/session/${sessionId}/execute/sync`, {
      script: "return document.body ? document.body.innerText.slice(0, 3000) : ''",
      args: [],
    });
    const bodyText = String(body.value || "");
    assert(bodyText.includes("OPEN CHATS") || bodyText.includes("new session"), "body text exposes ShellX UI");

    const screenshot = await webdriverRequest("GET", `/session/${sessionId}/screenshot`);
    const png = Buffer.from(String(screenshot.value || ""), "base64");
    writeFileSync(screenshotPath, png);
    const stat = statSync(screenshotPath);
    assert(stat.size > 20_000, `screenshot captured (${basename(screenshotPath)})`);

    await quitSession(sessionId);
    sessionId = null;
    console.log(`\nPASS tauri webdriver smoke (${platform})`);
    console.log(`evidence=${screenshotPath}`);
  } finally {
    if (sessionId) await quitSession(sessionId);
    child.kill("SIGTERM");
    await sleep(500);
    if (!child.killed) child.kill("SIGKILL");
  }
}

main().catch((err) => {
  console.error(`\nFAIL tauri webdriver smoke (${platform})`);
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
