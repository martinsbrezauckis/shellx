import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  releaseSurfaceDriverPhaseReportPassed,
  sealReleaseSurfaceDriverReport,
  validateReleaseSurfaceDriverReport,
  validateReleaseSurfaceDriverRequest,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "./release-surface-driver-protocol";
import { verifyReleaseSurfaceControllerBinding } from "./release-surface-controller-binding";

export async function runReleaseSurfaceDriverCli(
  manifest: ReleaseSurfaceDriverManifest,
  execute: (request: ReleaseSurfaceDriverRequest) => Promise<ReleaseSurfaceDriverReport>,
  args = process.argv.slice(2),
): Promise<void> {
  if (args.includes("--describe")) {
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return;
  }

  const requestPath = readArg(args, "--request");
  const outputPath = readArg(args, "--out");
  if (!requestPath || !outputPath) throw new Error("release driver requires --request <json> and --out <new-json>");
  if (existsSync(outputPath)) throw new Error(`release driver output already exists: ${outputPath}`);
  const request = JSON.parse(readFileSync(requestPath, "utf8")) as ReleaseSurfaceDriverRequest;
  const requestErrors = validateReleaseSurfaceDriverRequest(manifest, request);
  if (requestErrors.length > 0) throw new Error(`invalid release driver request: ${requestErrors.join("; ")}`);
  const controllerErrors = verifyReleaseSurfaceControllerBinding({
    rootDir: process.cwd(),
    binding: request.controller,
  });
  if (controllerErrors.length > 0) {
    throw new Error(`release driver controller binding is invalid: ${controllerErrors.join("; ")}`);
  }
  if (resolve(process.cwd(), request.controller.entrypoint.relativePath) !== resolve(process.argv[1] ?? "")) {
    throw new Error("release driver process does not match the exact bound controller entrypoint");
  }

  const report = sealReleaseSurfaceDriverReport(request, await execute(request));
  const controllerAfterErrors = verifyReleaseSurfaceControllerBinding({
    rootDir: process.cwd(),
    binding: request.controller,
  });
  if (controllerAfterErrors.length > 0) {
    throw new Error(`release driver controller changed during execution: ${controllerAfterErrors.join("; ")}`);
  }
  const reportErrors = validateReleaseSurfaceDriverReport(request, report);
  if (reportErrors.length > 0) throw new Error(`invalid release driver report: ${reportErrors.join("; ")}`);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  if (!releaseSurfaceDriverPhaseReportPassed(report)) throw new Error(`release driver ${manifest.id} recorded one or more failed surfaces`);
}

function readArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}
