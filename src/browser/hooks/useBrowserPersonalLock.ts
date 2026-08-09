import { useEffect, useRef, useState } from "react";

import { updateBrowserPersonalLock } from "../api";
import type { BrowserPersonalLockSettings } from "../types";
import { inTauri } from "../../lib/tauri-bridge";
import { isTrustedShellxUserEvent, type ShellxUserEventLike } from "../../lib/trusted-user-event";

interface BrowserPersonalLockPatch {
  enabled?: boolean;
  timeoutMinutes?: number;
  authMode?: BrowserPersonalLockSettings["authMode"];
  blurLockedTabs?: boolean;
  pauseDelegatedTabsWhenLocked?: boolean;
  lockOnSleep?: boolean;
  lockOnMinimize?: boolean;
  newPin?: string;
}

interface BrowserPersonalLockOptions {
  lock: BrowserPersonalLockSettings;
  onCloseTransientUi: () => void;
  refresh: () => Promise<void>;
  runBusy: (action: () => Promise<void>) => Promise<void>;
  setError: (message: string | null) => void;
}

export function useBrowserPersonalLock(options: BrowserPersonalLockOptions) {
  const { lock, onCloseTransientUi, refresh, runBusy, setError } = options;
  const lastActivitySyncRef = useRef(0);
  const lastTickRef = useRef(Date.now());
  const attentionTimerRef = useRef<number | null>(null);
  const [pinDraft, setPinDraft] = useState("");
  const [attention, setAttention] = useState(false);

  useEffect(() => {
    return () => {
      if (attentionTimerRef.current !== null) window.clearTimeout(attentionTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!lock.enabled) return;
    const recordTrustedActivity = () => {
      if (lock.locked) return;
      const now = Date.now();
      if (now - lastActivitySyncRef.current < 30_000) return;
      lastActivitySyncRef.current = now;
      void updateBrowserPersonalLock({
        action: "trustedActivity",
        trustedUserActivity: true,
      }).then(() => refresh()).catch(() => undefined);
    };
    window.addEventListener("pointerdown", recordTrustedActivity, true);
    window.addEventListener("keydown", recordTrustedActivity, true);
    return () => {
      window.removeEventListener("pointerdown", recordTrustedActivity, true);
      window.removeEventListener("keydown", recordTrustedActivity, true);
    };
  }, [lock.enabled, lock.locked, refresh]);

  useEffect(() => {
    if (!lock.enabled) return;
    const timer = window.setInterval(() => {
      void updateBrowserPersonalLock({}).then(() => refresh()).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [lock.enabled, refresh]);

  useEffect(() => {
    lastTickRef.current = Date.now();
    if (!lock.enabled || lock.locked || !lock.lockOnSleep) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      const driftMs = now - lastTickRef.current;
      lastTickRef.current = now;
      if (driftMs < 120_000) return;
      void updateBrowserPersonalLock({ action: "lockNow" }).then(() => refresh()).catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [lock.enabled, lock.lockOnSleep, lock.locked, refresh]);

  useEffect(() => {
    if (!inTauri() || !lock.enabled || lock.locked || !lock.lockOnMinimize) return;
    let cancelled = false;
    const checkMinimized = async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const minimized = await getCurrentWindow().isMinimized();
        if (cancelled || !minimized) return;
        await updateBrowserPersonalLock({ action: "lockNow" });
        await refresh();
      } catch {
        // Minimize state is best-effort; timeout and manual lock remain authoritative.
      }
    };
    const timer = window.setInterval(() => void checkMinimized(), 2_000);
    void checkMinimized();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [lock.enabled, lock.lockOnMinimize, lock.locked, refresh]);

  const isPolicyMessage = (message: string): boolean => {
    return message.toLowerCase().includes("personal browser is locked");
  };

  const focusToggle = () => {
    setAttention(true);
    if (attentionTimerRef.current !== null) window.clearTimeout(attentionTimerRef.current);
    attentionTimerRef.current = window.setTimeout(() => {
      setAttention(false);
      attentionTimerRef.current = null;
    }, 3600);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>("[data-debug-id='shellx-browser-personal-lock-toggle']")?.focus();
    });
  };

  const showBlockedNotice = () => {
    onCloseTransientUi();
    setError("Personal Browser Lock is on. Unlock personal tabs before opening or using personal pages.");
    focusToggle();
  };

  const updateSettings = (patch: BrowserPersonalLockPatch, event?: ShellxUserEventLike | null) => {
    if (!isTrustedShellxUserEvent(event)) return;
    void runBusy(async () => {
      await updateBrowserPersonalLock(patch);
      if (patch.newPin) setPinDraft("");
    });
  };

  const runAction = (
    action: "lockNow" | "unlock",
    pin = pinDraft,
    event?: ShellxUserEventLike | null,
  ) => {
    if (!isTrustedShellxUserEvent(event)) return;
    let resolvedPin = pin;
    if (action === "unlock" && lock.authMode === "pinOnly" && lock.pinConfigured && !resolvedPin.trim()) {
      const enteredPin = window.prompt("Enter Personal Browser Lock PIN");
      if (!enteredPin) return;
      resolvedPin = enteredPin;
    }
    void runBusy(async () => {
      await updateBrowserPersonalLock({ action, pin: resolvedPin });
      if (action === "unlock") setPinDraft("");
    });
  };

  return {
    attention,
    isPolicyMessage,
    pinDraft,
    runAction,
    setPinDraft,
    showBlockedNotice,
    updateSettings,
  };
}
