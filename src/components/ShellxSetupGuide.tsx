import { useEffect, useMemo, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ShellIcon, type ShellIconName } from "./icons";
import type { SettingsTab, SettingsValues } from "../lib/settings";
import type { VaultPanelIntent } from "../lib/vault-ui";

const SETUP_GUIDE_DISMISSED_KEY = "shellX.setupGuide.dismissed.v1";
export const SHELLX_SETUP_GUIDE_DISMISSED_EVENT = "shellx:setup-guide-dismissed";

interface SetupGuideVaultStatus {
  mode?: "unconfigured" | "legacyLimited" | "local" | "external";
  unlocked?: boolean;
  recoveryConfirmed?: boolean;
  initialized?: boolean;
}

type SetupGuideStep = {
  id: string;
  label: string;
  status: string;
  ready: boolean;
  icon: ShellIconName;
  onClick: () => void;
};

export function ShellxSetupGuide({
  settings,
  requestCount,
  agentsConfigured,
  onOpenVault,
  onOpenBrowser,
  onOpenRequests,
  onOpenSettingsTab,
}: {
  settings: SettingsValues;
  requestCount: number;
  agentsConfigured: boolean;
  onOpenVault: (intent?: VaultPanelIntent) => void;
  onOpenBrowser: () => void;
  onOpenRequests: () => void;
  onOpenSettingsTab: (tab: SettingsTab) => void;
}): JSX.Element | null {
  const [dismissed, setDismissed] = useState(() => readSetupGuideDismissed());
  const [vaultStatus, setVaultStatus] = useState<SetupGuideVaultStatus | null>(null);

  useEffect(() => {
    const onDismissedChange = (event: Event) => {
      const dismissed = Boolean((event as CustomEvent<{ dismissed?: boolean }>).detail?.dismissed);
      writeSetupGuideDismissed(dismissed);
      setDismissed(dismissed);
    };
    window.addEventListener(SHELLX_SETUP_GUIDE_DISMISSED_EVENT, onDismissedChange);
    return () => window.removeEventListener(SHELLX_SETUP_GUIDE_DISMISSED_EVENT, onDismissedChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    invoke<SetupGuideVaultStatus>("vault_status")
      .then((status) => {
        if (!cancelled) setVaultStatus(status);
      })
      .catch(() => {
        if (!cancelled) setVaultStatus(null);
      });
    const onChanged = () => {
      void invoke<SetupGuideVaultStatus>("vault_status")
        .then((status) => {
          if (!cancelled) setVaultStatus(status);
        })
        .catch(() => {
          if (!cancelled) setVaultStatus(null);
        });
    };
    window.addEventListener("shellx:vault-status-changed", onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("shellx:vault-status-changed", onChanged);
    };
  }, []);

  const steps = useMemo<SetupGuideStep[]>(() => {
    const vaultReady = Boolean(
      vaultStatus?.recoveryConfirmed &&
      vaultStatus.mode !== "unconfigured" &&
      vaultStatus.mode !== "legacyLimited",
    );
    const downloadsReady = settings.browserDownloadFolder.trim().length > 0;
    return [
      {
        id: "vault",
        label: "Vault",
        status: vaultReady ? "Ready" : "Set up",
        ready: vaultReady,
        icon: "lock",
        onClick: () => onOpenVault(vaultReady ? "overview" : "setup"),
      },
      {
        id: "browser",
        label: "Browser",
        status: "Open",
        ready: true,
        icon: "browser-orbit",
        onClick: onOpenBrowser,
      },
      {
        id: "downloads",
        label: "Downloads",
        status: downloadsReady ? "Folder set" : "Choose folder",
        ready: downloadsReady,
        icon: "download",
        onClick: () => onOpenSettingsTab("general"),
      },
      {
        id: "agents",
        label: "Agents",
        status: agentsConfigured ? "Ready" : "Check setup",
        ready: agentsConfigured,
        icon: "terminal",
        onClick: () => onOpenSettingsTab("shellxagent"),
      },
      {
        id: "requests",
        label: "Requests",
        status: requestCount === 0 ? "Clear" : `${requestCount} waiting`,
        ready: requestCount === 0,
        icon: requestCount === 0 ? "circle-check" : "alert",
        onClick: onOpenRequests,
      },
    ];
  }, [agentsConfigured, onOpenBrowser, onOpenRequests, onOpenSettingsTab, onOpenVault, requestCount, settings.browserDownloadFolder, vaultStatus]);

  if (dismissed) return null;

  const readyCount = steps.filter((step) => step.ready).length;

  return (
    <section className="shellx-setup-guide" data-debug-id="shellx-setup-guide" aria-label="ShellX setup guide">
      <div className="shellx-setup-guide-title">
        <ShellIcon name="sparkles" size={14} />
        <strong>Setup guide</strong>
        <span>{readyCount}/{steps.length} ready</span>
      </div>
      <div className="shellx-setup-guide-steps">
        {steps.map((step) => (
          <button
            key={step.id}
            type="button"
            className={`shellx-setup-step ${step.ready ? "ready" : "todo"}`}
            data-debug-id={`shellx-setup-step-${step.id}`}
            onClick={step.onClick}
            title={`${step.label}: ${step.status}`}
          >
            <ShellIcon name={step.icon} size={14} />
            <span>{step.label}</span>
            <small>{step.status}</small>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="shellx-setup-guide-close"
        data-debug-id="shellx-setup-guide-dismiss"
        aria-label="Dismiss setup guide"
        title="Dismiss setup guide"
        onClick={() => {
          writeSetupGuideDismissed(true);
          setDismissed(true);
        }}
      >
        <ShellIcon name="close" size={13} />
      </button>
    </section>
  );
}

function readSetupGuideDismissed(): boolean {
  try {
    return localStorage.getItem(SETUP_GUIDE_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

function writeSetupGuideDismissed(dismissed: boolean): void {
  try {
    localStorage.setItem(SETUP_GUIDE_DISMISSED_KEY, String(dismissed));
  } catch {
    // Local persistence is a convenience only.
  }
}
