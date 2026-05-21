/**
 * scripts/test-permission-pill.ts — issue #374.
 *
 * Unit-test for the permission-pill insertion + resolution paths in
 * src/lib/grouping.ts. Plain Node script (no test runner): pass
 * criteria are hand-coded assertions printed with ✓/✗ markers, exit
 * code 0/1. Wired into `pnpm test` and the `frontend` job in
 * `.github/workflows/ci.yml`.
 *
 * Cases covered:
 *   1. A `permission-request` event with `reqId` + ACP toolCall params
 *      inserts a `PermissionGroup` with `pending: true`. A subsequent
 *      synthetic `permission-resolved` event mutates the same group to
 *      `pending: false` + decision + decisionAt.
 *   2. A `permission-request` event with `autoApproved: true`
 *      (bypassPermissions / always-approve path) inserts an
 *      already-resolved PermissionGroup with `autoDecision: true`. No
 *      buttons render in this state — the audit trail is the point.
 *   3. Legacy `terminal/create` shape (request_id + command/args/cwd at
 *      top level) also produces a PermissionGroup with toolName +
 *      toolArgs derived from the legacy fields.
 *   4. Two emits with the same reqId (registry insert + autoApproved
 *      re-emit) collapse to ONE pill that ends up resolved.
 */
import { groupEvents } from "../src/lib/grouping";
import type { RawEventFrame } from "../src/types/acp";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

function header(s: string): void {
  console.log(`\n=== ${s} ===`);
}

/* ───────────── case 1: pending → resolved via synthetic event ───── */
header("case 1: insert pending pill, resolve via synthetic event");
{
  const evs: RawEventFrame[] = [
    {
      t: 1000,
      kind: "permission-request",
      payload: {
        reqId: "req-abc",
        params: {
          toolCall: {
            title: "Run bash",
            kind: "execute",
            rawInput: { command: "ls /tmp" },
          },
          options: [
            { optionId: "allow_once", kind: "allow_once" },
            { optionId: "allow_always", kind: "allow_always" },
            { optionId: "reject", kind: "reject" },
          ],
        },
      },
    },
  ];
  let groups = groupEvents(evs);
  const perms = groups.filter((g) => g.kind === "permission");
  assert(perms.length === 1, "one PermissionGroup emitted");
  const g = perms[0] as any;
  assert(g.requestId === "req-abc", "requestId == reqId");
  assert(g.pending === true, "pending is true");
  assert(g.toolName === "Run bash", "toolName from title");
  assert(typeof g.toolArgs === "string" && g.toolArgs.includes("ls /tmp"), "toolArgs preview includes command");
  assert(g.decision === undefined, "decision unset while pending");

  // Now append a resolved synthetic event.
  evs.push({
    t: 2500,
    kind: "permission-resolved",
    payload: {
      requestId: "req-abc",
      decision: "allow_always",
      decisionAt: 2500,
    },
  });
  groups = groupEvents(evs);
  const perms2 = groups.filter((g) => g.kind === "permission");
  assert(perms2.length === 1, "still one PermissionGroup after resolve");
  const g2 = perms2[0] as any;
  assert(g2.pending === false, "pending flipped to false");
  assert(g2.decision === "allow_always", "decision is allow_always");
  assert(g2.decisionAt === 2500, "decisionAt stamped from event");
  assert(g2.autoDecision === false, "autoDecision false for user click");
}

/* ───────────── case 2: bypassPermissions auto-approve ───── */
header("case 2: autoApproved at emit time → already-resolved pill");
{
  const evs: RawEventFrame[] = [
    {
      t: 1000,
      kind: "permission-request",
      payload: {
        reqId: "req-bypass-1",
        params: {
          toolCall: {
            title: "Write file",
            kind: "edit",
            rawInput: { path: "/etc/test.md", text: "hello" },
          },
        },
        autoApproved: true,
        permissionMode: "bypassPermissions",
      },
    },
  ];
  const groups = groupEvents(evs);
  const perms = groups.filter((g) => g.kind === "permission");
  assert(perms.length === 1, "one PermissionGroup emitted");
  const g = perms[0] as any;
  assert(g.pending === false, "pending false (auto-approved)");
  assert(g.decision === "allow", "decision allow");
  assert(g.autoDecision === true, "autoDecision true");
  assert(g.permissionMode === "bypassPermissions", "permissionMode carried through");
}

/* ───────────── case 3: legacy terminal/create shape ───── */
header("case 3: legacy terminal/create payload (no toolCall)");
{
  const evs: RawEventFrame[] = [
    {
      t: 1000,
      kind: "permission-request",
      payload: {
        request_id: "req-term-1",
        scope: "terminal/create",
        command: "rm",
        args: ["-rf", "/tmp/foo"],
        cwd: "/home/user",
      },
    },
  ];
  const groups = groupEvents(evs);
  const perms = groups.filter((g) => g.kind === "permission");
  assert(perms.length === 1, "one PermissionGroup emitted");
  const g = perms[0] as any;
  assert(g.requestId === "req-term-1", "requestId from request_id");
  assert(g.toolName === "terminal/create", "toolName from scope");
  assert(g.toolArgs.includes("rm"), "toolArgs preview includes command");
  assert(g.cwd === "/home/user", "cwd carried");
  assert(g.pending === true, "pending true");
}

/* ───────────── case 4: dual emit collapses to single resolved pill ──── */
header("case 4: registry-insert + auto re-emit collapse to one resolved pill");
{
  const evs: RawEventFrame[] = [
    {
      t: 1000,
      kind: "permission-request",
      payload: {
        reqId: "req-dual",
        params: { toolCall: { title: "Edit", kind: "edit" } },
      },
    },
    {
      t: 1010,
      kind: "permission-request",
      payload: {
        reqId: "req-dual",
        params: { toolCall: { title: "Edit", kind: "edit" } },
        autoApproved: true,
        permissionMode: "bypassPermissions",
      },
    },
  ];
  const groups = groupEvents(evs);
  const perms = groups.filter((g) => g.kind === "permission");
  assert(perms.length === 1, "still ONE PermissionGroup after dual emit");
  const g = perms[0] as any;
  assert(g.pending === false, "pending false after auto-approve re-emit");
  assert(g.decision === "allow", "decision allow");
  assert(g.autoDecision === true, "autoDecision true");
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
