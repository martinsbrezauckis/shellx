import assert from "node:assert/strict";
import { createTaskManagerSaveGuard } from "../../src/lib/task-manager-save-guard";

const guard = createTaskManagerSaveGuard();
const preflight = deferred<boolean>();
let saves = 0;

const firstSave = guard.run(
  () => preflight.promise,
  async () => {
    saves += 1;
    return "saved";
  },
);
const duplicateSave = await guard.run(
  async () => true,
  async () => {
    saves += 1;
    return "duplicate";
  },
);

assert.deepEqual(duplicateSave, { kind: "busy" }, "a pending save preflight must reject a duplicate save");
assert.equal(saves, 0, "no durable save may begin before its preflight completes");
preflight.resolve(true);
assert.deepEqual(await firstSave, { kind: "saved", value: "saved" });
assert.equal(saves, 1, "only the first save may run after its preflight succeeds");

console.log("Task Manager save preflight passed: asynchronous provider rechecks remain single-flight.");

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve: (value) => resolve!(value) };
}
