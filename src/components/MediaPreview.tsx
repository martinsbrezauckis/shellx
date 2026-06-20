import {
  useEffect,
  useState,
  type ImgHTMLAttributes,
  type JSX,
  type MouseEventHandler,
  type VideoHTMLAttributes,
} from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { normalizeRendererFilePath } from "../lib/media-paths";
import { inTauri } from "../lib/tauri-bridge";

export function SafeImg({
  src,
  alt,
  tabId,
  sessionCwd,
  ...rest
}: { src?: string; alt: string; tabId?: string; sessionCwd?: string } & ImgHTMLAttributes<HTMLImageElement>): JSX.Element {
  const [fallback, setFallback] = useState<{ src: string; dataUrl: string } | null>(null);
  useEffect(() => {
    setFallback(null);
  }, [src]);
  if (!src) return <span className="img-broken">[image: {alt}]</span>;
  const requestPath = normalizeRendererFilePath(src);
  const dataUrl = fallback?.src === requestPath ? fallback.dataUrl : null;
  let resolved = dataUrl ?? requestPath;
  if (!dataUrl) {
    if (/^(https?:|data:|asset:|tauri:|file:)/i.test(requestPath)) {
      resolved = requestPath;
    } else if (requestPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(requestPath)) {
      try { resolved = convertFileSrc(requestPath, "asset"); } catch { /* fall through */ }
    }
  }
  return (
    <img
      src={resolved}
      alt={alt}
      className="md-img"
      loading="lazy"
      onError={() => {
        if (dataUrl || !inTauri()) return;
        void invoke<string>("read_image_as_data_url", { path: requestPath, tabId, sessionCwd })
          .then((url) => { if (url) setFallback({ src: requestPath, dataUrl: url }); })
          .catch(() => { /* leave broken */ });
      }}
      {...rest}
    />
  );
}

export function SafeVideo({
  src,
  title,
  tabId,
  sessionCwd,
  controls = true,
  className = "md-video",
  preload = "metadata",
  onClick,
}: {
  src?: string;
  title: string;
  tabId?: string;
  sessionCwd?: string;
  controls?: boolean;
  className?: string;
  preload?: VideoHTMLAttributes<HTMLVideoElement>["preload"];
  onClick?: MouseEventHandler<HTMLVideoElement>;
}): JSX.Element {
  const [fallback, setFallback] = useState<{ src: string; dataUrl: string } | null>(null);
  useEffect(() => {
    setFallback(null);
  }, [src]);
  if (!src) return <span className="img-broken">[video: {title}]</span>;
  const requestPath = normalizeRendererFilePath(src);
  const dataUrl = fallback?.src === requestPath ? fallback.dataUrl : null;
  let resolved = dataUrl ?? requestPath;
  if (!dataUrl) {
    if (/^(https?:|data:|asset:|tauri:|file:)/i.test(requestPath)) {
      resolved = requestPath;
    } else if (requestPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(requestPath)) {
      try { resolved = convertFileSrc(requestPath, "asset"); } catch { /* fall through */ }
    }
  }
  return (
    <video
      src={resolved}
      controls={controls}
      preload={preload}
      className={className}
      title={title}
      onClick={onClick}
      onError={() => {
        if (dataUrl || !inTauri()) return;
        void invoke<string>("read_image_as_data_url", { path: requestPath, tabId, sessionCwd })
          .then((url) => { if (url) setFallback({ src: requestPath, dataUrl: url }); })
          .catch(() => { /* leave broken */ });
      }}
    />
  );
}
