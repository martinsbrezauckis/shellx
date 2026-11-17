import { lazy } from "react";

export const BookmarkSidecar = lazy(() => import("./components/BookmarkSidecar"));
export const BrowserHistorySidecar = lazy(() => import("./components/BrowserHistorySidecar")
  .then((module) => ({ default: module.BrowserHistorySidecar })));
export const DownloadSidecar = lazy(() => import("./components/DownloadSidecar")
  .then((module) => ({ default: module.DownloadSidecar })));
export const BrowserShieldsPanel = lazy(() => import("./components/BrowserShieldsPanel")
  .then((module) => ({ default: module.BrowserShieldsPanel })));
export const BrowserVaultFillPanel = lazy(() => import("./components/BrowserVaultFillPanel")
  .then((module) => ({ default: module.BrowserVaultFillPanel })));
export const BrowserTabHandoffConfirmation = lazy(() => import("./components/BrowserTabHandoffConfirmation")
  .then((module) => ({ default: module.BrowserTabHandoffConfirmation })));
