import {
  transportKindForValue,
  transportLabelForKind,
  type TransportKind,
} from "../src/lib/transport-icons";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

function expectKind(value: unknown, expected: TransportKind, label: string): void {
  assert(transportKindForValue(value) === expected, label);
}

console.log("\n=== transport icon normalization ===");

expectKind("local", "local", "keeps local transport id");
expectKind("wsl", "wsl", "keeps wsl transport id");
expectKind("ssh", "ssh", "keeps ssh transport id");
expectKind("tailscale", "tailscale", "keeps tailscale transport id");
expectKind("ws_tunnel", "cloud", "maps ws_tunnel to cloud");
expectKind("💻", "local", "maps legacy local emoji");
expectKind("🐧", "wsl", "maps legacy WSL emoji");
expectKind("🔐", "ssh", "maps legacy SSH emoji");
expectKind("🌐", "tailscale", "maps legacy Tailscale emoji");
expectKind("☁", "cloud", "maps legacy cloud emoji");
expectKind("🔗", "remote", "maps legacy link emoji");
expectKind("unexpected", "remote", "unknown transport falls back to remote");

assert(transportLabelForKind("local") === "Local", "labels local");
assert(transportLabelForKind("wsl") === "WSL", "labels WSL");
assert(transportLabelForKind("cloud") === "Cloud", "labels cloud");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} transport icon tests`);
process.exit(failures === 0 ? 0 : 1);
