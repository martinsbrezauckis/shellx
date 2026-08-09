import { useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";

import { controlBrowserTaskFromOperator, finishBrowserTaskFromOperator } from "../api";
import { inferBrowserTaskStartUrl } from "../taskIntent";
import type { BrowserAutonomy, BrowserTask } from "../types";
import { isTrustedShellxUserEvent, type ShellxUserEventLike } from "../../lib/trusted-user-event";

const DEFAULT_GOAL = "Browse the page, extract needed information, and report with receipts.";

interface BrowserCoworkSendRequest {
  prompt: string;
  startUrl?: string | null;
  profileId?: string | null;
  autonomy?: BrowserAutonomy | null;
}

interface BrowserTasksOptions {
  activeTask: BrowserTask | null;
  address: string;
  agentDefaultProfileId: string;
  autonomy: BrowserAutonomy;
  busy: boolean;
  profileId: string;
  refresh: () => Promise<void>;
  runBusy: (action: () => Promise<void>) => Promise<void>;
  runTaskControl: (action: () => Promise<void>) => Promise<void>;
  sendPrompt: (request: BrowserCoworkSendRequest) => Promise<unknown>;
  setError: (message: string | null) => void;
  setProfileId: (value: string) => void;
  showChat: () => void;
  userDefaultProfileId: string;
}

export function useBrowserTasks(options: BrowserTasksOptions) {
  const {
    activeTask,
    address,
    agentDefaultProfileId,
    autonomy,
    busy,
    profileId,
    refresh,
    runBusy,
    runTaskControl,
    sendPrompt,
    setError,
    setProfileId,
    showChat,
    userDefaultProfileId,
  } = options;
  const [goal, setGoal] = useState(DEFAULT_GOAL);

  const startBrowserTaskWithGoal = async (taskGoal: string, startUrl?: string | null): Promise<void> => {
    const cleanGoal = taskGoal.trim();
    if (!cleanGoal) return;
    const taskProfileId = profileId === userDefaultProfileId ? agentDefaultProfileId : profileId;
    await sendPrompt({
      prompt: cleanGoal,
      startUrl: startUrl?.trim() || undefined,
      profileId: taskProfileId,
      autonomy,
    });
    setProfileId(taskProfileId);
    setGoal("");
    await refresh();
  };

  const startTask = (event: ShellxUserEventLike) => {
    if (!isTrustedShellxUserEvent(event)) {
      setError("Sending a Browser cowork message requires direct user input.");
      return;
    }
    const taskGoal = goal.trim();
    if (!taskGoal || busy) return;
    const startUrl = inferBrowserTaskStartUrl(taskGoal, address.trim());
    showChat();
    void runBusy(async () => {
      await startBrowserTaskWithGoal(taskGoal, startUrl);
    });
  };

  const submitTask = (event: FormEvent) => {
    event.preventDefault();
    startTask(event);
  };

  const submitTaskFromKeyboard = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    startTask(event);
  };

  const finishTask = (status: "completed" | "blocked", event: MouseEvent<HTMLButtonElement>) => {
    if (!activeTask) return;
    if (!isTrustedShellxUserEvent(event)) {
      setError("Browser task completion requires a direct user click.");
      return;
    }
    void runTaskControl(async () => {
      await finishBrowserTaskFromOperator({ taskId: activeTask.taskId, status });
    });
  };

  const controlTask = (
    action: "pause" | "resume" | "abort" | "userTakeover",
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    if (!activeTask) return;
    if (!isTrustedShellxUserEvent(event)) {
      setError("Browser task operator controls require a direct user click.");
      return;
    }
    void runTaskControl(async () => {
      await controlBrowserTaskFromOperator({ taskId: activeTask.taskId, action });
    });
  };

  return {
    controlTask,
    finishTask,
    goal,
    setGoal,
    startBrowserTaskWithGoal,
    submitTask,
    submitTaskFromKeyboard,
  };
}
