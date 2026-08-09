import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { releaseSurfaceMacosNativeInputFileIdentity } from "./lib/release-surface-macos-native-input";

if (process.platform !== "darwin") {
  throw new Error("macOS native-input helper compilation must run on the Mac candidate host");
}

const args = process.argv.slice(2);
const sourcePath = resolve(readArg(args, "--source")
  ?? resolve(import.meta.dirname, "native", "macos-release-input.swift"));
const outputPath = resolve(requiredArg(args, "--out"));
const sourceStat = lstatSync(sourcePath);
if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
  throw new Error("macOS native-input Swift source must be a regular non-symlink file");
}
const sourceBefore = releaseSurfaceMacosNativeInputFileIdentity(sourcePath);
if (existsSync(outputPath)) throw new Error("macOS native-input helper output must not already exist");
if (basename(outputPath) !== "shellx-release-macos-native-input") {
  throw new Error("macOS native-input helper output must use the exact release-helper basename");
}
assertDisposableFinalProfile(outputPath);

const run = spawnSync("/usr/bin/xcrun", [
  "swiftc",
  "-O",
  "-framework", "AppKit",
  "-framework", "ApplicationServices",
  sourcePath,
  "-o", outputPath,
], {
  encoding: "utf8",
  timeout: 120_000,
  maxBuffer: 1024 * 1024,
  env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
});
if (run.status !== 0) {
  throw new Error(`macOS native-input helper compilation failed: ${(run.stderr || run.stdout).trim().slice(0, 4_000)}`);
}
chmodSync(outputPath, 0o700);
const source = releaseSurfaceMacosNativeInputFileIdentity(sourcePath);
if (source.basename !== sourceBefore.basename
  || source.sha256 !== sourceBefore.sha256
  || source.bytes !== sourceBefore.bytes) {
  throw new Error("macOS native-input Swift source changed while the helper was compiling");
}
const helper = releaseSurfaceMacosNativeInputFileIdentity(outputPath);
console.log(JSON.stringify({
  schema: "shellx/release-surface-macos-native-input-build@1",
  source,
  helper,
  signed: false,
  installedIntoApplication: false,
  permissionPromptRequested: false,
}, null, 2));

function assertDisposableFinalProfile(path: string): void {
  let current = dirname(path);
  while (true) {
    if (/^shellx-final-webdriver-[a-f0-9]{16,64}$/.test(basename(current))) return;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("macOS native-input helper output must live inside the exact disposable final-run profile");
}

function readArg(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index >= 0
    ? values[index + 1]
    : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
}

function requiredArg(values: string[], name: string): string {
  const value = readArg(values, name);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
