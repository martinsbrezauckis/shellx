import type { JSX } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUp,
  Ban,
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
  Cloud,
  Copy,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  Globe2,
  Headphones,
  Image,
  Link,
  LoaderCircle,
  Lock,
  MessageSquare,
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
  Square,
  Terminal,
  Trash2,
  Video,
  X,
  type LucideIcon,
} from "lucide-react";
import { transportKindForValue, transportLabelForKind, type TransportKind } from "../lib/transport-icons";

export type ShellIconName =
  | "activity"
  | "alert"
  | "arrow-up"
  | "ban"
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
  | "close"
  | "copy"
  | "external-link"
  | "file"
  | "folder"
  | "folder-open"
  | "git-branch"
  | "headphones"
  | "image"
  | "link"
  | "loader"
  | "lock"
  | "message"
  | "mic"
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
  | "square"
  | "terminal"
  | "trash"
  | "video";

const ICONS: Record<ShellIconName, LucideIcon> = {
  activity: Activity,
  alert: AlertTriangle,
  "arrow-up": ArrowUp,
  ban: Ban,
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
  close: X,
  copy: Copy,
  "external-link": ExternalLink,
  file: FileText,
  folder: Folder,
  "folder-open": FolderOpen,
  "git-branch": GitBranch,
  headphones: Headphones,
  image: Image,
  link: Link,
  loader: LoaderCircle,
  lock: Lock,
  message: MessageSquare,
  mic: Mic,
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
  square: Square,
  terminal: Terminal,
  trash: Trash2,
  video: Video,
};

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
