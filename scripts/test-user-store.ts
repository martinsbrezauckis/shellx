import {
  LEGACY_SESSION_TABS_KEY,
  SESSION_TABS_KEY,
  USER_DATA_KEYS,
  mergeUserDataBlobs,
  normalizeUserDataBlob,
  readUserDataLocalStorage,
} from "../src/lib/userStore";

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
  USER_DATA_KEYS.includes(SESSION_TABS_KEY),
  "saved session tabs use the ShellX namespace",
);
assert(
  !USER_DATA_KEYS.includes(LEGACY_SESSION_TABS_KEY as any),
  "legacy grok-shell saved-session key is not canonical",
);
assert(
  USER_DATA_KEYS.includes("shellX.v92.projects.collapse"),
  "project expanded/collapsed markings are mirrored to reinstall-safe user data",
);
assert(
  new Set(USER_DATA_KEYS).size === USER_DATA_KEYS.length,
  "user data key list has no duplicates",
);

const storage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => storage.has(key) ? storage.get(key)! : null,
  setItem: (key: string, value: string) => { storage.set(key, String(value)); },
  removeItem: (key: string) => { storage.delete(key); },
};
const legacyTabs = [{
  tabId: "tab-legacy",
  sessionId: "sess-legacy",
  title: "Custom saved name",
  titleLocked: true,
  projectId: "proj-legacy",
  cwd: "C:\\Users\\FixtureUser\\project",
}];
storage.set(LEGACY_SESSION_TABS_KEY, JSON.stringify(legacyTabs));
const migrated = readUserDataLocalStorage(SESSION_TABS_KEY);
assert(
  Boolean(
    migrated?.includes("tab-legacy") &&
      migrated.includes("Custom saved name") &&
      migrated.includes('"titleLocked":true') &&
      migrated.includes("proj-legacy"),
  ) && storage.has(SESSION_TABS_KEY),
  "legacy saved sessions migrate with custom names and project markings",
);
assert(
  !storage.has(LEGACY_SESSION_TABS_KEY),
  "legacy saved-session key is removed after local migration",
);

const diskBlob = normalizeUserDataBlob({
  [LEGACY_SESSION_TABS_KEY]: legacyTabs,
  "shellX.projects.v1": [{ id: "proj-legacy", name: "Saved project", path: "" }],
  "shellX.chatTitles.v1": { "sess-legacy": "Custom saved name" },
  "shellX.sessionProjects.v1": { "sess-legacy": "proj-legacy" },
  "shellX.closedTabs.v1": [{ tabId: "tab-closed", title: "Closed custom name", sessionId: "sess-closed", closedAtMs: 1 }],
  "shellX.v92.projects.collapse": { "proj-legacy": false },
  "shellX.futurePersonalData.v1": { keep: true },
});
assert(
  Array.isArray(diskBlob[SESSION_TABS_KEY]) &&
    (diskBlob[SESSION_TABS_KEY] as any[])[0]?.title === "Custom saved name" &&
    (diskBlob[SESSION_TABS_KEY] as any[])[0]?.titleLocked === true &&
    (diskBlob[SESSION_TABS_KEY] as any[])[0]?.projectId === "proj-legacy",
  "disk user-data migration preserves saved tab names, locks, and project markers",
);
assert(
  diskBlob[LEGACY_SESSION_TABS_KEY] === undefined,
  "disk user-data migration removes legacy saved-session section",
);
assert(
  (diskBlob["shellX.chatTitles.v1"] as Record<string, string>)["sess-legacy"] === "Custom saved name" &&
    (diskBlob["shellX.sessionProjects.v1"] as Record<string, string>)["sess-legacy"] === "proj-legacy",
  "disk user-data migration preserves past-chat names and project assignments",
);
assert(
  (diskBlob["shellX.futurePersonalData.v1"] as Record<string, boolean>)?.keep === true,
  "disk user-data migration preserves unknown future personal-data sections",
);

const earlyWriteMerge = mergeUserDataBlobs(
  {
    "shellX.projects.v1": [{ id: "proj-old", name: "Existing project", path: "" }],
    "shellX.chatTitles.v1": { "sess-old": "Existing saved name" },
    "shellX.sessionProjects.v1": { "sess-old": "proj-old" },
    "shellX.futurePersonalData.v1": { keep: true },
  },
  {
    [SESSION_TABS_KEY]: [{
      tabId: "tab-new",
      sessionId: "sess-new",
      title: "New tab",
      titleLocked: true,
      projectId: "proj-new",
    }],
  },
);
assert(
  Array.isArray(earlyWriteMerge["shellX.projects.v1"]) &&
    (earlyWriteMerge["shellX.chatTitles.v1"] as Record<string, string>)["sess-old"] === "Existing saved name" &&
    (earlyWriteMerge["shellX.sessionProjects.v1"] as Record<string, string>)["sess-old"] === "proj-old" &&
    (earlyWriteMerge["shellX.futurePersonalData.v1"] as Record<string, boolean>)?.keep === true &&
    Array.isArray(earlyWriteMerge[SESSION_TABS_KEY]),
  "early writes merge with disk data before replacing user-data.json",
);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} user store tests`);
process.exit(failures === 0 ? 0 : 1);
