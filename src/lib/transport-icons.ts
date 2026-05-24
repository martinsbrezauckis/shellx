export type TransportKind = "local" | "wsl" | "ssh" | "tailscale" | "cloud" | "remote";

const LEGACY_TRANSPORTS: Record<string, TransportKind> = {
  "💻": "local",
  "🐧": "wsl",
  "🔐": "ssh",
  "🌐": "tailscale",
  "☁": "cloud",
  "☁️": "cloud",
  "🔗": "remote",
};

const TRANSPORT_ALIASES: Record<string, TransportKind> = {
  local: "local",
  desktop: "local",
  wsl: "wsl",
  linux: "wsl",
  ssh: "ssh",
  remote_ssh: "ssh",
  tailscale: "tailscale",
  tailnet: "tailscale",
  ws_tunnel: "cloud",
  tunnel: "cloud",
  cloud: "cloud",
  remote: "remote",
  link: "remote",
};

export function transportKindForValue(value: unknown): TransportKind {
  if (typeof value !== "string") return "remote";
  const trimmed = value.trim();
  if (!trimmed) return "remote";
  const legacy = LEGACY_TRANSPORTS[trimmed];
  if (legacy) return legacy;
  const normalized = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  return TRANSPORT_ALIASES[normalized] ?? "remote";
}

export function transportLabelForKind(kind: TransportKind): string {
  switch (kind) {
    case "local": return "Local";
    case "wsl": return "WSL";
    case "ssh": return "SSH";
    case "tailscale": return "Tailscale";
    case "cloud": return "Cloud";
    case "remote": return "Remote";
  }
}
