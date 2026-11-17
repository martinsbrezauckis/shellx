import { open as openDialog } from "@tauri-apps/plugin-dialog";

/** Production dialog wrapper shared by user-initiated file and folder flows. */
export async function openShellxDialog(
  options: Parameters<typeof openDialog>[0],
): Promise<Awaited<ReturnType<typeof openDialog>>> {
  return await openDialog(options);
}
