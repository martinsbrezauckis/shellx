import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

import { inTauri } from "./tauri-bridge";

export type ShellxReleasePickerKind = "file" | "directory";

export type ShellxReleasePickerClaim = {
  kind: ShellxReleasePickerKind;
  path: string;
  pathSha256: string;
  syntheticText?: string;
};

/**
 * Consume a one-shot picker result only in an attested isolated candidate.
 * Normal app instances return null and continue into the real OS dialog.
 */
export async function takeShellxReleasePickerClaim(
  kind: ShellxReleasePickerKind,
): Promise<ShellxReleasePickerClaim | null> {
  if (!inTauri()) return null;
  return await invoke<ShellxReleasePickerClaim | null>("release_test_take_native_picker", { kind });
}

/** Production dialog wrapper with a one-shot release-candidate result lease. */
export async function openShellxDialog(
  options: Parameters<typeof openDialog>[0],
): Promise<Awaited<ReturnType<typeof openDialog>>> {
  const kind: ShellxReleasePickerKind = options?.directory ? "directory" : "file";
  const claim = await takeShellxReleasePickerClaim(kind);
  if (claim) {
    return (options?.multiple ? [claim.path] : claim.path) as Awaited<ReturnType<typeof openDialog>>;
  }
  return await openDialog(options);
}
