import { basename } from "node:path";
import {
  releaseSurfacePosixPathDigest,
  type ReleaseSurfacePosixNativeBinding,
} from "../lib/release-surface-posix-native-runtime";

export function releaseSurfacePosixNativeBindingFixture(input: {
  processId: number;
  port: number;
  imagePath: string;
  imageSha256: string;
  imageBytes?: number;
  platform?: "linux" | "macos";
}): ReleaseSurfacePosixNativeBinding {
  const platform = input.platform ?? "linux";
  return {
    schema: "shellx/release-surface-posix-native-binding@1",
    platform,
    process: {
      pid: input.processId,
      startId: platform === "linux"
        ? "linux:12345678-1234-1234-1234-123456789abc:424242"
        : "macos:1785430923000",
      imageBasename: basename(input.imagePath),
      imagePathSha256: releaseSurfacePosixPathDigest(input.imagePath),
      imageSha256: input.imageSha256,
      imageBytes: input.imageBytes ?? 1024,
      imageFileId: "8:123456",
    },
    listener: {
      address: "127.0.0.1",
      port: input.port,
      owningPid: input.processId,
      ...(platform === "linux" ? { socketId: "inode:987654" } : {}),
    },
  };
}
