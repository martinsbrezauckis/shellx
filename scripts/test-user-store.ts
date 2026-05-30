import { USER_DATA_KEYS } from "../src/lib/userStore";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== user data persistence keys ===");

assert(
  USER_DATA_KEYS.includes("shellX.projects.v1"),
  "project markers are mirrored to reinstall-safe user data",
);
assert(
  USER_DATA_KEYS.includes("shellX.sessionProjects.v1"),
  "session-to-project markings are mirrored to reinstall-safe user data",
);
assert(
  USER_DATA_KEYS.includes("shellX.v92.projects.collapse"),
  "project expanded/collapsed markings are mirrored to reinstall-safe user data",
);
assert(
  new Set(USER_DATA_KEYS).size === USER_DATA_KEYS.length,
  "user data key list has no duplicates",
);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} user store tests`);
process.exit(failures === 0 ? 0 : 1);
