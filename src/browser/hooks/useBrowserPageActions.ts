import type { MouseEvent } from "react";

import {
  browserApiPostJson,
  copyBrowserLocalArtifact,
  grantBrowserTransfer,
  writeBrowserTextArtifact,
} from "../api";
import { inTauri } from "../../lib/tauri-bridge";
import { openShellxDialog } from "../../lib/shellx-dialog";
import { isTrustedShellxUserEvent } from "../../lib/trusted-user-event";
import type { BrowserPageSaveKind, BrowserTransferEntry } from "../types";
import type { BrowserObservationLike } from "../vaultFillCandidates";
import {
  browserExplainGoal,
  browserLinksFromObservation,
  pageSaveBaseName,
  pageSaveDisplayName,
  pageSaveReason,
  safeBrowserStatusUrl,
} from "../browserPresentation";

type BrowserImmediateSaveKind = Exclude<BrowserPageSaveKind, "media" | "code" | "site">;

interface BrowserScreenshotLike {
  path: string;
  bytes: number;
  sha256: string;
  width?: number | null;
  height?: number | null;
  fullPage?: boolean;
  pageWidth?: number | null;
  pageHeight?: number | null;
  title?: string | null;
}

interface BrowserActionResponseLike {
  message?: string | null;
  observation?: BrowserObservationLike | null;
  screenshot?: BrowserScreenshotLike | null;
}

interface BrowserPageActionsOptions {
  actionContext: () => Record<string, unknown>;
  activeBrowserTabId: string | null;
  activeTaskId: string | null;
  defaultDownloadFolder: string;
  pageTitle: string | null;
  pageUrl: string;
  runBusy: (action: () => Promise<void>) => Promise<void>;
  setDefaultDownloadFolder: (value: string) => void;
  setError: (message: string | null) => void;
  startBrowserTaskWithGoal: (goal: string, startUrl?: string | null) => Promise<void>;
  onExplainStart: () => void;
  onSaveComplete: () => void;
  onSaveStart: () => void;
}

export function useBrowserPageActions(options: BrowserPageActionsOptions) {
  const {
    actionContext,
    activeBrowserTabId,
    activeTaskId,
    defaultDownloadFolder,
    pageTitle,
    pageUrl,
    runBusy,
    setDefaultDownloadFolder,
    setError,
    startBrowserTaskWithGoal,
    onExplainStart,
    onSaveComplete,
    onSaveStart,
  } = options;

  const completeLocalDownload = async (input: {
    kind: BrowserPageSaveKind;
    url: string;
    fileName: string;
    finalPath: string;
    mimeType?: string | null;
    bytes: number;
    sha256: string;
  }): Promise<void> => {
    const transfer = await browserApiPostJson<BrowserTransferEntry>("/browser/downloads/request", {
      ...(activeTaskId ? { taskId: activeTaskId } : {}),
      ...(activeBrowserTabId ? { browserTabId: activeBrowserTabId } : {}),
      ...(defaultDownloadFolder.trim() ? { destinationDir: defaultDownloadFolder.trim() } : {}),
      url: input.url,
      fileName: input.fileName,
      reason: pageSaveReason(input.kind),
    });
    const approval = await grantBrowserTransfer({
      transferId: transfer.transferId,
      direction: "download",
      origin: input.url,
      sha256: input.sha256,
      ttlSeconds: 300,
    });
    await browserApiPostJson<BrowserTransferEntry>("/browser/downloads/complete", {
      transferId: transfer.transferId,
      finalPath: input.finalPath,
      mimeType: input.mimeType,
      bytes: input.bytes,
      sha256: input.sha256,
      sourceUrl: input.url,
      destination: "local-downloads",
      retentionReason: pageSaveReason(input.kind),
      approvalId: approval.approvalId,
    });
  };

  const writeLocalTextDownload = async (input: {
    kind: BrowserPageSaveKind;
    url: string;
    fileName: string;
    content: string;
    mimeType: string;
  }): Promise<void> => {
    const artifact = await writeBrowserTextArtifact({
      destinationDir: defaultDownloadFolder.trim() || undefined,
      fileName: input.fileName,
      content: input.content,
    });
    await completeLocalDownload({
      kind: input.kind,
      url: input.url,
      fileName: artifact.displayName || input.fileName,
      finalPath: artifact.finalPath,
      mimeType: artifact.mimeType || input.mimeType,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    });
  };

  const copyLocalFileDownload = async (input: {
    kind: BrowserPageSaveKind;
    url: string;
    fileName: string;
    sourcePath: string;
    mimeType: string;
  }): Promise<void> => {
    const artifact = await copyBrowserLocalArtifact({
      sourcePath: input.sourcePath,
      destinationDir: defaultDownloadFolder.trim() || undefined,
      fileName: input.fileName,
    });
    await completeLocalDownload({
      kind: input.kind,
      url: input.url,
      fileName: artifact.displayName || input.fileName,
      finalPath: artifact.finalPath,
      mimeType: artifact.mimeType || input.mimeType,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    });
  };

  const captureScreenshotForSave = async (
    kind: "screenshot" | "fullPageScreenshot",
    url: string,
    title?: string | null,
  ): Promise<BrowserScreenshotLike> => {
    const fullPage = kind === "fullPageScreenshot";
    const response = await browserApiPostJson<BrowserActionResponseLike>("/browser/action", {
      ...actionContext(),
      ...(activeTaskId ? { taskId: activeTaskId } : {}),
      action: "captureScreenshot",
      fullPage,
    });
    const screenshot = response.screenshot;
    if (!screenshot?.path) {
      throw new Error(response.message || "Browser screenshot did not produce an artifact.");
    }
    const fileName = `${pageSaveBaseName(url, title || screenshot.title)}${fullPage ? "-fullpage" : "-window"}.png`;
    await copyLocalFileDownload({
      kind,
      url,
      fileName,
      sourcePath: screenshot.path,
      mimeType: "image/png",
    });
    return screenshot;
  };

  const extractObservationForSave = async (): Promise<BrowserObservationLike> => {
    const response = await browserApiPostJson<BrowserActionResponseLike>("/browser/action", {
      ...actionContext(),
      ...(activeTaskId ? { taskId: activeTaskId } : {}),
      action: "extractMarkdown",
    });
    if (!response.observation) {
      throw new Error(response.message || "Browser extraction did not return page content.");
    }
    return response.observation;
  };

  const requestImmediatePageSave = async (
    kind: BrowserImmediateSaveKind,
    url: string,
  ): Promise<void> => {
    const title = pageTitle || url;
    if (kind === "screenshot" || kind === "fullPageScreenshot") {
      await captureScreenshotForSave(kind, url, title);
      return;
    }

    const observation = await extractObservationForSave();
    const base = pageSaveBaseName(url, observation.title || title);
    if (kind === "markdown") {
      const markdown = observation.markdown || observation.text || "";
      if (!markdown.trim()) throw new Error("Browser extraction returned empty Markdown.");
      await writeLocalTextDownload({
        kind,
        url,
        fileName: `${base}.md`,
        content: markdown,
        mimeType: "text/markdown",
      });
      return;
    }

    const links = browserLinksFromObservation(observation);
    if (kind === "linksJson") {
      await writeLocalTextDownload({
        kind,
        url,
        fileName: `${base}-links.json`,
        content: JSON.stringify({
          sourceUrl: observation.url || url,
          title: observation.title || title,
          capturedAt: new Date().toISOString(),
          count: links.length,
          links,
        }, null, 2),
        mimeType: "application/json",
      });
      return;
    }

    const screenshot = await captureScreenshotForSave("fullPageScreenshot", url, observation.title || title);
    await writeLocalTextDownload({
      kind,
      url,
      fileName: `${base}-snapshot.json`,
      content: JSON.stringify({
        sourceUrl: observation.url || url,
        title: observation.title || title,
        capturedAt: new Date().toISOString(),
        domSummary: observation.domSummary ?? null,
        markdown: observation.markdown || observation.text || "",
        links,
        screenshot: {
          path: screenshot.path,
          bytes: screenshot.bytes,
          sha256: screenshot.sha256,
          width: screenshot.width ?? null,
          height: screenshot.height ?? null,
          fullPage: screenshot.fullPage === true,
          pageWidth: screenshot.pageWidth ?? null,
          pageHeight: screenshot.pageHeight ?? null,
        },
      }, null, 2),
      mimeType: "application/json",
    });
  };

  const requestQueuedPageSave = async (kind: BrowserPageSaveKind, url: string): Promise<void> => {
    await browserApiPostJson("/browser/downloads/request", {
      ...(activeTaskId ? { taskId: activeTaskId } : {}),
      ...(activeBrowserTabId ? { browserTabId: activeBrowserTabId } : {}),
      ...(defaultDownloadFolder.trim() ? { destinationDir: defaultDownloadFolder.trim() } : {}),
      url,
      fileName: pageSaveDisplayName(kind),
      reason: pageSaveReason(kind),
    });
  };

  const requestExplainPage = async (url: string): Promise<void> => {
    let observation: BrowserObservationLike | null = null;
    try {
      observation = await extractObservationForSave();
    } catch {
      observation = null;
    }
    const safeStartUrl = safeBrowserStatusUrl(observation?.url || url);
    const taskGoal = browserExplainGoal({ url, title: pageTitle, observation });
    await startBrowserTaskWithGoal(
      taskGoal,
      safeStartUrl.startsWith("about:") ? null : safeStartUrl || null,
    );
  };

  const requestPageSave = (kind: BrowserPageSaveKind, event: MouseEvent<HTMLButtonElement>) => {
    if (!isTrustedShellxUserEvent(event)) return;
    if (!pageUrl) {
      setError("Open a page before saving Browser content.");
      return;
    }
    onSaveStart();
    void runBusy(async () => {
      if (kind === "screenshot" || kind === "fullPageScreenshot" || kind === "markdown" || kind === "linksJson" || kind === "snapshotJson") {
        await requestImmediatePageSave(kind, pageUrl);
      } else {
        await requestQueuedPageSave(kind, pageUrl);
      }
      onSaveComplete();
    });
  };

  const requestChatExplainPage = (event: MouseEvent<HTMLButtonElement>) => {
    if (!isTrustedShellxUserEvent(event)) {
      setError("Explain page requires a direct user click.");
      return;
    }
    if (!pageUrl) {
      setError("Open a page before asking the Browser agent to explain it.");
      return;
    }
    onExplainStart();
    void runBusy(async () => {
      await requestExplainPage(pageUrl);
    });
  };

  const chooseDefaultDownloadFolder = () => {
    if (!inTauri()) {
      setError("Folder picker is available in the ShellX desktop app.");
      return;
    }
    void runBusy(async () => {
      const selected = await openShellxDialog({ directory: true, multiple: false });
      const value = Array.isArray(selected) ? selected[0] : selected;
      if (typeof value === "string" && value.trim()) {
        setDefaultDownloadFolder(value);
      }
    });
  };

  return {
    chooseDefaultDownloadFolder,
    requestChatExplainPage,
    requestPageSave,
  };
}
