import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import {
  collectReleaseSurfacePosixNativeRuntime,
  parseReleaseSurfaceLinuxStartId,
  parseReleaseSurfaceMacosLsofOwner,
  parseReleaseSurfaceMacosStartId,
  parseReleaseSurfaceMacosTextIdentity,
  releaseSurfacePosixPathDigest,
  toReleaseSurfacePosixNativeBinding,
  validateReleaseSurfacePosixNativeRuntime,
  validateReleaseSurfacePosixRuntimeBinding,
  type ReleaseSurfacePosixNativeRuntime,
} from "./lib/release-surface-posix-native-runtime";

assert.equal(
  parseReleaseSurfaceLinuxStartId(
    "123 (a process name) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 424242 20",
    "12345678-1234-1234-1234-123456789ABC\n",
  ),
  "linux:12345678-1234-1234-1234-123456789abc:424242",
);
assert.equal(
  parseReleaseSurfaceMacosStartId("Wed Jul 30 17:02:03 2026"),
  `macos:${Date.UTC(2026, 6, 30, 17, 2, 3)}`,
);
assert.equal(parseReleaseSurfaceMacosLsofOwner("p4321\nf12\nn127.0.0.1:30123\n", 4321, 30123), 4321);
assert.throws(
  () => parseReleaseSurfaceMacosLsofOwner("p9999\nf12\nn127.0.0.1:30123\n", 4321, 30123),
  /not uniquely owned/,
);
assert.deepEqual(parseReleaseSurfaceMacosTextIdentity(
  "p4321\nftxt\nD0x1a\ni43\ns4096\nn/Applications/ShellX.app/Contents/MacOS/shellx\n",
  4321,
  "/Applications/ShellX.app/Contents/MacOS/shellx",
), { imageFileId: "1a:2b", imageBytes: 4096 });
assert.throws(
  () => parseReleaseSurfaceMacosTextIdentity(
    "p4321\nftxt\nD0x1a\ni43\ns4096\nn/tmp/replaced-shellx\n",
    4321,
    "/Applications/ShellX.app/Contents/MacOS/shellx",
  ),
  /loaded executable vnode is not unique/,
);

const macosPath = "/Applications/ShellX.app/Contents/MacOS/shellx";
const macosObservation: ReleaseSurfacePosixNativeRuntime = {
  schema: "shellx/release-surface-posix-native-runtime@1",
  collector: "macos-ps-lsof-v1",
  platform: "macos",
  observedAt: "2026-07-30T17:02:04.000Z",
  osVersion: "25.5.0",
  architecture: "arm64",
  process: {
    pid: 4321,
    startId: `macos:${Date.UTC(2026, 6, 30, 17, 2, 3)}`,
    imageBasename: "shellx",
    imagePathSha256: releaseSurfacePosixPathDigest(macosPath),
    imageSha256: "a".repeat(64),
    imageBytes: 4096,
    imageFileId: "1a:2b",
  },
  listener: { address: "127.0.0.1", port: 30123, owningPid: 4321 },
};
assert.deepEqual(validateReleaseSurfacePosixNativeRuntime(macosObservation, {
  platform: "macos",
  processId: 4321,
  port: 30123,
  imagePath: macosPath,
  imageSha256: "a".repeat(64),
}), []);
const macosBinding = toReleaseSurfacePosixNativeBinding(macosObservation);
assert.deepEqual(validateReleaseSurfacePosixRuntimeBinding(macosBinding, macosObservation), []);
assert(!JSON.stringify(macosBinding).includes(macosPath));
const macosHandoff = structuredClone(macosObservation);
macosHandoff.listener.owningPid = 9999;
assert(validateReleaseSurfacePosixNativeRuntime(macosHandoff, {
  platform: "macos",
  processId: 4321,
  port: 30123,
}).some((error) => error.includes("listener owner")));

if (process.platform === "linux") {
  const server = createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const observation = collectReleaseSurfacePosixNativeRuntime({
      platform: "linux",
      processId: process.pid,
      port: address.port,
    });
    const executablePath = realpathSync(`/proc/${process.pid}/exe`);
    assert.deepEqual(validateReleaseSurfacePosixNativeRuntime(observation, {
      platform: "linux",
      processId: process.pid,
      port: address.port,
      imagePath: executablePath,
      imageSha256: observation.process.imageSha256,
    }), []);
    const binding = toReleaseSurfacePosixNativeBinding(observation);
    assert.deepEqual(validateReleaseSurfacePosixRuntimeBinding(binding, observation), []);
    assert.match(binding.process.startId, /^linux:[0-9a-f-]{36}:[1-9][0-9]*$/);
    assert.match(binding.process.imageFileId, /^[a-f0-9]+:[a-f0-9]+$/);
    assert.match(binding.listener.socketId!, /^inode:[1-9][0-9]*$/);
    assert.equal(binding.process.imagePathSha256, releaseSurfacePosixPathDigest(executablePath));
    const serialized = JSON.stringify(binding);
    assert(!serialized.includes(executablePath));
    assert(!serialized.includes("\"imagePath\":"), "public POSIX binding must not expose a raw machine path field");

    const reusedPid = structuredClone(binding);
    reusedPid.process.startId = reusedPid.process.startId.replace(/[0-9]+$/, "999999999");
    assert(validateReleaseSurfacePosixRuntimeBinding(reusedPid, observation).some((error) => error.includes("changed")));
    const replacedFile = structuredClone(binding);
    replacedFile.process.imageFileId = "1:1";
    assert(validateReleaseSurfacePosixRuntimeBinding(replacedFile, observation).some((error) => error.includes("changed")));
    const replacedListener = structuredClone(binding);
    replacedListener.listener.socketId = "inode:999999999";
    assert(validateReleaseSurfacePosixRuntimeBinding(replacedListener, observation).some((error) => error.includes("changed")));
    assert.throws(
      () => collectReleaseSurfacePosixNativeRuntime({ platform: "linux", processId: process.ppid, port: address.port }),
      /not owned/,
    );
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

console.log("Release surface POSIX native runtime tests passed");
