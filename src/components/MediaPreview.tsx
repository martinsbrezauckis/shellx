import {
  useEffect,
  useRef,
  useState,
  type ImgHTMLAttributes,
  type JSX,
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
}: {
  src?: string;
  title: string;
  tabId?: string;
  sessionCwd?: string;
  controls?: boolean;
  className?: string;
  preload?: VideoHTMLAttributes<HTMLVideoElement>["preload"];
}): JSX.Element {
  const [fallback, setFallback] = useState<{ src: string; dataUrl: string } | null>(null);
  const [playbackState, setPlaybackState] = useState<"idle" | "loading" | "playing" | "paused" | "ended" | "error">("idle");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    setFallback(null);
    setPlaybackState("idle");
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
  async function togglePlayback(): Promise<void> {
    const video = videoRef.current;
    if (!video) return;
    if (!video.paused && !video.ended) {
      video.pause();
      setPlaybackState("paused");
      return;
    }
    setPlaybackState("loading");
    try {
      await video.play();
      setPlaybackState("playing");
    } catch {
      setPlaybackState("error");
    }
  }
  const video = (
    <video
      ref={videoRef}
      src={resolved}
      controls={controls}
      preload={preload}
      className={className}
      title={title}
      onCanPlay={() => setPlaybackState((current) => current === "loading" ? "idle" : current)}
      onPlaying={() => setPlaybackState("playing")}
      onPause={() => setPlaybackState((current) => current === "idle" ? current : "paused")}
      onEnded={() => setPlaybackState("ended")}
      onError={() => {
        if (dataUrl || !inTauri()) {
          setPlaybackState("error");
          return;
        }
        setPlaybackState("loading");
        void invoke<string>("read_image_as_data_url", { path: requestPath, tabId, sessionCwd })
          .then((url) => {
            if (url) setFallback({ src: requestPath, dataUrl: url });
            else setPlaybackState("error");
          })
          .catch(() => setPlaybackState("error"));
      }}
    />
  );
  if (!controls) return video;

  const playing = playbackState === "playing";
  const loading = playbackState === "loading";
  return (
    <div className="safe-video-frame">
      {video}
      <button
        data-debug-id="surface-components-mediapreview-1"
        data-shellx-release-observe="pressed title"
        type="button"
        className="safe-video-playback-toggle"
        aria-label={loading ? "Starting video preview" : playing ? "Pause video preview" : "Play video preview"}
        aria-pressed={playing}
        disabled={loading}
        title={`Video playback · state=${playbackState}`}
        onClick={() => void togglePlayback()}
      >
        {loading ? "Starting…" : playing ? "Pause" : "Play"}
      </button>
    </div>
  );
}
