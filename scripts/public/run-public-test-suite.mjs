import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testCommandInvocation } from "./lib/test-command-runtime.mjs";
import { PUBLIC_TEST_SUITE } from "./public-test-suite-manifest.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

for (let index = 0; index < PUBLIC_TEST_SUITE.length; index += 1) {
  const command = PUBLIC_TEST_SUITE[index];
  const invocation = testCommandInvocation(command);
  console.log(`\n[shellx:public ${index + 1}/${PUBLIC_TEST_SUITE.length}] ${command.join(" ")}`);
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
