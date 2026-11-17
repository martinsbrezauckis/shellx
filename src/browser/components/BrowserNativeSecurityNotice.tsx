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
      Strict on {capabilities.platform} keeps ShellX in-page filtering and presentation suppression, but cannot prefilter every native subresource before the engine sends it.
      Native permission, password-autosave, and general-autofill controls are also unavailable; ShellX still denies unmanaged popups, so keep permission and credential flows operator-led.
    </div>
  );
}
