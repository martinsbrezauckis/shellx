import type { JSX } from "react";

import type { DebugUiConnectionStatus } from "../lib/debug-ui-connection";
import { ShellIcon } from "./icons";

export function DebugApiConnectionBanner({
  status,
  onRetry,
}: {
  status: DebugUiConnectionStatus;
  onRetry: () => void;
}): JSX.Element | null {
  if (status !== "disconnected") return null;
  return (
    <div className="debug-api-connection-banner" data-debug-id="debug-api-disconnected" role="status">
      <ShellIcon name="plug" size={14} />
      <span>Desktop services disconnected</span>
      <button
        type="button"
        data-debug-id="debug-api-retry"
        title="Retry desktop services now"
        onClick={onRetry}
      >
        <ShellIcon name="refresh" size={13} />
        Retry
      </button>
    </div>
  );
}
