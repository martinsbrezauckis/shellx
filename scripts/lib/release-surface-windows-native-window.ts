import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { ReleaseSurfaceWindowsNativeBinding } from "./release-surface-windows-native-runtime";

const RECEIPT_SCHEMA = "shellx/release-surface-windows-window-close@1";

export type ReleaseSurfaceWindowsNativeWindowCloseReceipt = {
  schema: typeof RECEIPT_SCHEMA;
  processId: number;
  processStartId: string;
  title: "ShellX Browser";
  closed: true;
};

export function closeReleaseSurfaceWindowsNativeWindow(
  binding: ReleaseSurfaceWindowsNativeBinding,
  title: "ShellX Browser",
  options?: {
    powershellPath?: string;
    run?: typeof spawnSync;
    scriptPath?: string;
  },
): ReleaseSurfaceWindowsNativeWindowCloseReceipt {
  const process = binding.process;
  if (!Number.isSafeInteger(process.pid) || process.pid <= 0) {
    throw new Error("Windows native window close requires a positive candidate PID");
  }
  if (!Number.isFinite(Date.parse(process.startId))) {
    throw new Error("Windows native window close requires the candidate process start identity");
  }
  if (!isAbsolute(process.imagePath) && !/^(?:[a-z]:[\\/]|\\\\)/i.test(process.imagePath)) {
    throw new Error("Windows native window close requires an absolute candidate executable path");
  }
  const scriptPath = options?.scriptPath
    ?? windowsReadablePath(resolve(import.meta.dirname, "..", "close-release-surface-windows-window.ps1"));
  const result = (options?.run ?? spawnSync)(options?.powershellPath ?? "powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-CandidateProcessId", String(process.pid),
    "-CandidateStartId", process.startId,
    "-CandidateImagePath", process.imagePath,
    "-ExpectedTitle", title,
  ], { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || result.error?.message || "Windows native window close failed").trim());
  }
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("Windows native window close returned no receipt");
  const receipt = JSON.parse(line) as Partial<ReleaseSurfaceWindowsNativeWindowCloseReceipt>;
  if (receipt.schema !== RECEIPT_SCHEMA
    || receipt.processId !== process.pid
    || receipt.processStartId !== process.startId
    || receipt.title !== title
    || receipt.closed !== true) {
    throw new Error("Windows native window close receipt does not match the exact candidate binding");
  }
  return receipt as ReleaseSurfaceWindowsNativeWindowCloseReceipt;
}

function windowsReadablePath(path: string): string {
  if (process.platform === "win32") return path;
  if (process.platform !== "linux") {
    throw new Error("Windows native window close requires native Windows or WSL interop");
  }
  const result = spawnSync("wslpath", ["-w", path], { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`unable to map Windows native window close script path ${path}`);
  }
  return result.stdout.trim();
}
