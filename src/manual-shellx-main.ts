import {
  installPublicManualControlReporter,
} from "./lib/public-manual-preview";
import { mountShellxApp } from "./mount-shellx-app";
import "./manual-shellx.css";

document.documentElement.dataset.shellxPublicManualPreview = "true";
const phonePreviewNotice = document.createElement("aside");
phonePreviewNotice.className = "manual-phone-preview-notice";
phonePreviewNotice.setAttribute("role", "note");
phonePreviewNotice.textContent = "Desktop workspace preview. Swipe horizontally to inspect the full-size controls; they remain at their readable desktop size.";
document.body.prepend(phonePreviewNotice);
try {
  localStorage.setItem("shellX.setupGuide.dismissed.v1", "true");
  localStorage.setItem("shellX.settingsTab", "general");
} catch {
  // A privacy-restricted frame can still render the production component tree.
}
installPublicManualControlReporter();
mountShellxApp();
