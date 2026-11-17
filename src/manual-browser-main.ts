import {
  installPublicManualControlReporter,
} from "./lib/public-manual-preview";
import { publicManualBrowserState } from "./browser/publicManualFixture";
import { COLOR_MODE_STORAGE_KEY } from "./browser/browserPreferences";
import { mountShellxBrowser } from "./mount-shellx-browser";

document.documentElement.dataset.shellxPublicManualPreview = "true";
(globalThis as typeof globalThis & { __SHELLX_PUBLIC_MANUAL_BROWSER_STATE__?: unknown })
  .__SHELLX_PUBLIC_MANUAL_BROWSER_STATE__ = publicManualBrowserState();
try {
  localStorage.setItem(COLOR_MODE_STORAGE_KEY, "dark");
} catch {
  // A privacy-restricted frame can still render the production component tree.
}
installPublicManualControlReporter();
mountShellxBrowser();
