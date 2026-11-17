import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./tauri-bridge";

export type InstalledUpdatePackageKind = "appimage" | "deb" | "rpm" | "unknown";
export type UpdateInstallMethod = "automatic" | "manual";
type RuntimePlatform = "linux" | "other";

export const MANUAL_UPDATE_DOWNLOAD_URL = "https://github.com/martinsbrezauckis/shellx/releases/latest";

export function runtimePlatformFromUserAgent(userAgent: string): RuntimePlatform {
  return /\blinux\b/i.test(userAgent) ? "linux" : "other";
}

/**
 * The offered artifact is intentionally absent from this decision. A signed
 * AppImage in the updater manifest does not establish that the running app
 * was installed as an AppImage.
 */
export function updateInstallMethodFor(
  platform: RuntimePlatform,
  installedPackageKind: InstalledUpdatePackageKind,
): UpdateInstallMethod {
  return platform !== "linux" || installedPackageKind === "appimage"
    ? "automatic"
    : "manual";
}

/**
 * Query local package provenance only on Linux. The native command returns
 * `unknown` for unavailable or conflicting evidence; that must remain a
 * manual update path rather than reaching Tauri's AppImage installer.
 */
export async function resolveUpdateInstallMethod(
  userAgent: string = navigator.userAgent,
): Promise<UpdateInstallMethod> {
  const platform = runtimePlatformFromUserAgent(userAgent);
  if (platform !== "linux") return "automatic";
  if (!inTauri()) return "manual";
  try {
    const installedPackageKind = await invoke<InstalledUpdatePackageKind>("installed_update_package_kind");
    return updateInstallMethodFor(platform, installedPackageKind);
  } catch {
    return "manual";
  }
}
