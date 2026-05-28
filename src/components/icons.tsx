import type { JSX } from "react";
import {
  Activity,
  AlertTriangle,
  AppWindow,
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
  Smartphone,
  Square,
  SquareTerminal,
  Tablet,
  Terminal,
  Trash2,
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
  | "phone"
  | "square"
  | "tablet"
  | "terminal"
  | "trash"
  | "trace"
  | "video";

const ICONS: Record<ShellIconName, LucideIcon> = {
  activity: Activity,
  alert: AlertTriangle,
  "app-window": AppWindow,
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
  phone: Smartphone,
  square: Square,
  tablet: Tablet,
  terminal: SquareTerminal,
  trash: Trash2,
  trace: Workflow,
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
