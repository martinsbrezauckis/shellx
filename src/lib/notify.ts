/**
 * src/lib/notify.ts — desktop notification wrapper .
 *
 * Both grok (via the debug-api introspection loop) and the tool
 * landscape research independently flagged `notify_desktop` as the
 * highest-impact zero-effort native tool to add. Tauri ships
 * `tauri-plugin-notification` — this file is the thin TS surface
 * over it, with graceful no-op when running outside Tauri (Vite
 * browser preview, Playwright).
 *
 * Usage:
 * import { notify } from "./lib/notify";
 * notify({ title: "Build complete", body: "shellX installer ready" });
 *
 * First call triggers the permission prompt on OSes that gate it
 * (Linux: usually auto-granted; macOS: prompt once; Windows: usually
 * auto). Subsequent calls are immediate.
 */
import { inTauri } from "./tauri-bridge";

export interface NotifyArgs {
  title: string;
  body?: string;
 /** Linux/macOS only — Windows ignores. "low" | "normal" | "critical" */
  urgency?: "low" | "normal" | "critical";
}

let permissionCache: "granted" | "denied" | "default" | null = null;

async function ensurePermission(): Promise<boolean> {
  if (permissionCache === "granted") return true;
  if (permissionCache === "denied") return false;
  if (!inTauri()) return false;
  try {
    const { isPermissionGranted, requestPermission } = await import(
      "@tauri-apps/plugin-notification"
    );
    let granted = await isPermissionGranted();
    if (!granted) {
      const perm = await requestPermission();
      granted = perm === "granted";
    }
    permissionCache = granted ? "granted" : "denied";
    return granted;
  } catch (err) {
    console.warn("[notify] permission check failed:", err);
    permissionCache = "denied";
    return false;
  }
}

/**
 * Fire a desktop notification. No-op silently in browser preview.
 * Errors during permission/send are swallowed to a console.warn —
 * notifications are non-critical UX.
 */
export async function notify(args: NotifyArgs): Promise<void> {
  if (!inTauri()) return;
  try {
    const ok = await ensurePermission();
    if (!ok) return;
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification({ title: args.title, body: args.body });
  } catch (err) {
    console.warn("[notify] send failed:", err);
  }
}
