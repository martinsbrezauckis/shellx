import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testCommandInvocation, testSuiteRange } from "./lib/test-command-runtime.mjs";
import { TEST_SUITES } from "./test-suite-manifest.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const suiteName = process.argv[2];

if (!(suiteName in TEST_SUITES)) {
  console.error(`Usage: node scripts/run-test-suite.mjs <${Object.keys(TEST_SUITES).join("|")}> [--from <row>] [--to <row>]`);
  process.exit(2);
}

const suite = TEST_SUITES[suiteName];
let range;
try {
  range = testSuiteRange(process.argv.slice(3), suite.length);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
for (let index = range.startIndex; index < range.endIndex; index += 1) {
  const command = suite[index];
  const invocation = testCommandInvocation(command);
  console.log(`\n[shellx:${suiteName} ${index + 1}/${suite.length}] ${command.join(" ")}`);
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
