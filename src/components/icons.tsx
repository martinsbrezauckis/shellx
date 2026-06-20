import type { JSX } from "react";
import {
  Activity,
  AlertTriangle,
  AppWindow,
  ArrowUp,
  Ban,
  Bookmark,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Circle,
  CircleCheck,
  CircleX,
  Clock,
  Cloud,
  Copy,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  Globe2,
  Headphones,
  History,
  Home,
  Image,
  Inbox,
  Link,
  LoaderCircle,
  Lock,
  Maximize2,
  MessageSquare,
  Minimize2,
  Mic,
  Monitor,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Send,
  Settings,
  ShieldAlert,
  Sparkles,
  Smartphone,
  Square,
  SquareTerminal,
  Star,
  Tablet,
  Terminal,
  Trash2,
  UserCircle,
  Video,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { transportKindForValue, transportLabelForKind, type TransportKind } from "../lib/transport-icons";

export type ShellIconName =
  | "activity"
  | "alert"
  | "app-window"
  | "arrow-up"
  | "ban"
  | "bookmark"
  | "browser-orbit"
  | "camera"
  | "check"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "chevrons-left"
  | "chevrons-right"
  | "circle"
  | "circle-check"
  | "circle-x"
  | "clock"
  | "close"
  | "copy"
  | "download"
  | "eye"
  | "eye-off"
  | "external-link"
  | "file"
  | "folder"
  | "folder-open"
  | "git-branch"
  | "headphones"
  | "history"
  | "home"
  | "image"
  | "inbox"
  | "link"
  | "loader"
  | "lock"
  | "maximize"
  | "message"
  | "minimize"
  | "mic"
  | "monitor"
  | "paperclip"
  | "pause"
  | "pencil"
  | "play"
  | "plug"
  | "plus"
  | "refresh"
  | "rotate"
  | "search"
  | "send"
  | "settings"
  | "shield-alert"
  | "sparkles"
  | "phone"
  | "square"
  | "star"
  | "tablet"
  | "terminal"
  | "trash"
  | "trace"
  | "user"
  | "video";

const ICONS: Record<Exclude<ShellIconName, "browser-orbit">, LucideIcon> = {
  activity: Activity,
  alert: AlertTriangle,
  "app-window": AppWindow,
  "arrow-up": ArrowUp,
  ban: Ban,
  bookmark: Bookmark,
  camera: Camera,
  check: Check,
  "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  "chevrons-left": ChevronsLeft,
  "chevrons-right": ChevronsRight,
  circle: Circle,
  "circle-check": CircleCheck,
  "circle-x": CircleX,
  clock: Clock,
  close: X,
  copy: Copy,
  download: Download,
  eye: Eye,
  "eye-off": EyeOff,
  "external-link": ExternalLink,
  file: FileText,
  folder: Folder,
  "folder-open": FolderOpen,
  "git-branch": GitBranch,
  headphones: Headphones,
  history: History,
  home: Home,
  image: Image,
  inbox: Inbox,
  link: Link,
  loader: LoaderCircle,
  lock: Lock,
  maximize: Maximize2,
  message: MessageSquare,
  minimize: Minimize2,
  mic: Mic,
  monitor: Monitor,
  paperclip: Paperclip,
  pause: Pause,
  pencil: Pencil,
  play: Play,
  plug: Plug,
  plus: Plus,
  refresh: RefreshCw,
  rotate: RotateCw,
  search: Search,
  send: Send,
  settings: Settings,
  "shield-alert": ShieldAlert,
  sparkles: Sparkles,
  phone: Smartphone,
  square: Square,
  star: Star,
  tablet: Tablet,
  terminal: SquareTerminal,
  trash: Trash2,
  trace: Workflow,
  user: UserCircle,
  video: Video,
};

function BrowserOrbitIcon({
  size = 15,
  strokeWidth = 1.8,
  className = "",
  "aria-hidden": ariaHidden = true,
}: {
  size?: number;
  strokeWidth?: number;
  className?: string;
  "aria-hidden"?: boolean;
}): JSX.Element {
  const scale = 24 / size;
  return (
    <svg
      aria-hidden={ariaHidden}
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <ellipse
        cx="12"
        cy="12"
        rx="8.7"
        ry="4.15"
        transform="rotate(-24 12 12)"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.1 7.1 16.9 16.9M16.9 7.1 7.1 16.9"
        stroke="currentColor"
        strokeWidth={strokeWidth * 1.18}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx="17.8"
        cy="7.15"
        r={1.85 / scale}
        fill="currentColor"
      />
    </svg>
  );
}

const TRANSPORT_ICONS: Record<TransportKind, LucideIcon> = {
  local: Monitor,
  wsl: Terminal,
  ssh: Lock,
  tailscale: Globe2,
  cloud: Cloud,
  remote: Link,
};

export function ShellIcon({
  name,
  className = "",
  size = 15,
  strokeWidth = 1.8,
  "aria-hidden": ariaHidden = true,
}: {
  name: ShellIconName;
  className?: string;
  size?: number;
  strokeWidth?: number;
  "aria-hidden"?: boolean;
}): JSX.Element {
  if (name === "browser-orbit") {
    return (
      <BrowserOrbitIcon
        aria-hidden={ariaHidden}
        className={`sx-icon ${className}`.trim()}
        size={size}
        strokeWidth={strokeWidth}
      />
    );
  }
  const Icon = ICONS[name];
  return (
    <Icon
      aria-hidden={ariaHidden}
      className={`sx-icon ${className}`.trim()}
      size={size}
      strokeWidth={strokeWidth}
    />
  );
}

export function TransportIcon({
  value,
  className = "",
  size = 14,
}: {
  value?: unknown;
  className?: string;
  size?: number;
}): JSX.Element {
  const kind = transportKindForValue(value);
  const Icon = TRANSPORT_ICONS[kind];
  return (
    <Icon
      aria-hidden="true"
      className={`sx-icon sx-transport sx-transport-${kind} ${className}`.trim()}
      size={size}
      strokeWidth={1.8}
    />
  );
}

export function transportTitle(value?: unknown): string {
  return transportLabelForKind(transportKindForValue(value));
}
