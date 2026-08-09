import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { testCommandInvocation, testSuiteRange } from "./lib/test-command-runtime.mjs";
import { TEST_SUITES, REQUIRED_RELEASE_GATES } from "./test-suite-manifest.mjs";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

assert.equal(pkg.scripts.pretest, "node scripts/run-test-suite.mjs pretest");
assert.equal(pkg.scripts.test, "node scripts/run-test-suite.mjs test");
assert.equal(TEST_SUITES.pretest.length, 75);
assert.equal(TEST_SUITES.test.length, 102);
assert.deepEqual(
  testCommandInvocation(["node", "scripts/example.mjs", "--check"]),
  { executable: process.execPath, args: ["scripts/example.mjs", "--check"] },
  "node suite rows must use the current host-native Node executable",
);
assert.deepEqual(
  testCommandInvocation(["tsx", "scripts/example.ts", "--check"]),
  { executable: process.execPath, args: ["--import", "tsx", "scripts/example.ts", "--check"] },
  "tsx suite rows must use the portable Node loader instead of an extensionless POSIX shim",
);
assert.throws(
  () => testCommandInvocation(["shell", "scripts/example.sh"]),
  /unsupported test runtime/,
  "unknown suite runtimes must fail closed",
);
assert.deepEqual(testSuiteRange(["--from", "41", "--to", "102"], 102), { startIndex: 40, endIndex: 102 });
assert.deepEqual(testSuiteRange([], 102), { startIndex: 0, endIndex: 102 });
assert.throws(() => testSuiteRange(["--from", "0"], 102), /1 <= from <= to <= 102/);
assert.throws(() => testSuiteRange(["--to", "103"], 102), /1 <= from <= to <= 102/);
assert.throws(() => testSuiteRange(["--unknown", "1"], 102), /accepts only/);

for (const [suiteName, commands] of Object.entries(TEST_SUITES)) {
  assert(Object.isFrozen(commands), `${suiteName} command registry must be immutable`);
  for (const command of commands) {
    assert(Array.isArray(command) && command.length >= 2, `${suiteName} contains an invalid command row`);
    assert(command.every((token) => typeof token === "string" && token.length > 0));
    assert(!command.some((token) => token.includes("&&")), `${suiteName} must keep one reviewable command per row`);
    assert(["node", "tsx"].includes(command[0]), `${suiteName} uses an unexpected executable: ${command[0]}`);
    assert(existsSync(resolve(root, command[1])), `${suiteName} references a missing file: ${command[1]}`);
  }
}

const all = [...TEST_SUITES.pretest, ...TEST_SUITES.test].map((row) => JSON.stringify(row));
for (const required of REQUIRED_RELEASE_GATES) {
  assert(all.includes(JSON.stringify(required)), `required release gate is missing: ${required.join(" ")}`);
}
assert(
  TEST_SUITES.test.some((row) => row.join(" ") === "node scripts/test-test-suite-manifest.mjs"),
  "the explicit test registry must verify itself",
);

console.log(`ShellX test-suite manifest passed: ${TEST_SUITES.pretest.length} pretest + ${TEST_SUITES.test.length} test commands`);
