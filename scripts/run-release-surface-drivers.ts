import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ReleasePlatform, ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import { loadFinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import {
  releaseSurfaceDriverRunFailedDriverIds,
  runReleaseSurfaceDrivers,
} from "./lib/release-surface-driver-runner";
import { loadFinalSurfaceContract } from "./lib/release-surface-receipts";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const selectedDriverIds = readArgs(args, "--driver-id")
  .flatMap((value) => value.split(","))
  .map((value) => value.trim())
  .filter(Boolean);
const targetedClosure = selectedDriverIds.length > 0;
const expectedExecutionWindow = targetedClosure
  ? "targeted-post-matrix"
  : "immediately-before-publish";
if (readArg(args, "--candidate-stage") !== "signed-and-frozen"
  || readArg(args, "--execution-window") !== expectedExecutionWindow) {
  throw new Error(
    targetedClosure
      ? "refusing targeted execution: pass --candidate-stage signed-and-frozen "
        + "--execution-window targeted-post-matrix with one or more --driver-id values"
      : "refusing routine execution: pass --candidate-stage signed-and-frozen "
        + "--execution-window immediately-before-publish for the final candidate only",
  );
}
const platform = readArg(args, "--platform") as ReleasePlatform | undefined;
const artifactPath = readArg(args, "--artifact");
const signatureReceiptPath = readArg(args, "--signature-receipt");
const candidateAttestationPath = readArg(args, "--candidate-attestation");
const installationReceiptPath = readArg(args, "--installation-receipt");
const webdriverSessionPath = readArg(args, "--webdriver-session");
const macosNativeInputHelperPath = readArg(args, "--macos-native-input-helper");
const macosNativeInputBindingPath = readArg(args, "--macos-native-input-binding");
const outputDir = readArg(args, "--out-dir");
if (!platform || !["windows-installed", "macos-installed", "linux-installed"].includes(platform)) throw new Error("valid --platform is required");
if (!artifactPath || !signatureReceiptPath || !candidateAttestationPath || !installationReceiptPath || !outputDir) {
  throw new Error("--artifact, --signature-receipt, --candidate-attestation, --installation-receipt, and --out-dir are required");
}
if (Boolean(macosNativeInputHelperPath) !== Boolean(macosNativeInputBindingPath)) {
  throw new Error("--macos-native-input-helper and --macos-native-input-binding must be supplied together");
}
if (platform !== "macos-installed" && macosNativeInputHelperPath) {
  throw new Error("macOS native-input binding arguments are valid only for macos-installed");
}

const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (status.trim()) throw new Error("frozen-candidate driver run requires a clean source checkout");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const inventory = JSON.parse(readFileSync(join(root, "release", "surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
const nativeWebDriver = webdriverSessionPath ? readNativeWebDriverSession(webdriverSessionPath) : undefined;
const manifest = runReleaseSurfaceDrivers({
  rootDir: root,
  plan: loadFinalSurfaceDriverPlan(join(root, "release", "surface-driver-plan.json")),
  inventory,
  contract: loadFinalSurfaceContract(join(root, "release", "surface-contract.json")),
  platform,
  sourceCommit,
  version,
  artifactPath,
  signatureReceiptPath,
  candidateAttestationPath,
  installationReceiptPath,
  outputDir,
  ...(targetedClosure ? { selectedDriverIds } : {}),
  nativeWebDriver,
  ...(macosNativeInputHelperPath && macosNativeInputBindingPath
    ? { macosNativeInput: {
        helperPath: resolve(macosNativeInputHelperPath),
        bindingReceiptPath: resolve(macosNativeInputBindingPath),
      } }
    : {}),
});
const failedDriverIds = releaseSurfaceDriverRunFailedDriverIds(manifest, outputDir);
if (failedDriverIds.length > 0) {
  throw new Error(`complete discovery matrix recorded failed driver sections: ${failedDriverIds.join(", ")}`);
}
console.log(`${targetedClosure ? "Targeted closure" : "Final surface drivers"} passed ${manifest.driverReports.reduce((sum, report) => sum + report.outcomes, 0)} exact surfaces on ${platform}.`);
console.log(`Evidence: ${resolve(outputDir)}`);

function readArg(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  if (index >= 0) return values[index + 1];
  const prefix = `${name}=`;
  return values.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function readArgs(values: string[], name: string): string[] {
  const prefix = `${name}=`;
  return values.flatMap((value, index) => {
    if (value === name) return values[index + 1] ? [values[index + 1]!] : [];
    return value.startsWith(prefix) ? [value.slice(prefix.length)] : [];
  });
}

function readNativeWebDriverSession(path: string): { base: string; sessionId: string } {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`--webdriver-session must name a regular non-symlink JSON file: ${absolute}`);
  }
  const value = JSON.parse(readFileSync(absolute, "utf8")) as { base?: unknown; sessionId?: unknown };
  if (typeof value.base !== "string" || typeof value.sessionId !== "string") {
    throw new Error("--webdriver-session must contain string base and sessionId fields");
  }
  return { base: value.base, sessionId: value.sessionId };
}
