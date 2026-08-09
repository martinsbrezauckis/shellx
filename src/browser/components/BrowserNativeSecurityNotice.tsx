import type { JSX } from "react";

import type { BrowserNativeSecurityCapabilities } from "../types";

export function BrowserNativeSecurityNotice({
  capabilities,
}: {
  capabilities?: BrowserNativeSecurityCapabilities | null;
}): JSX.Element | null {
  if (!capabilities || capabilities.fullNativeProtection) return null;
  return (
    <div className="shellx-browser-native-security-notice" role="status">
      Native permission, password-autosave, and Strict request-filter hooks are unavailable on {capabilities.platform}.
      ShellX still denies unmanaged popups and disables general autofill; keep permission and credential flows operator-led on this platform.
    </div>
  );
}
