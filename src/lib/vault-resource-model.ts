import type { GrantOperation, GrantSummary } from "../components/settings/VaultGrantsPanel";

export type PermissionLevel = "userOnly" | "visible" | "browserFillAlways" | "toolUseAlways";
export type VaultResourceKind = "secret" | "profileCard" | "emailInbox" | "stripeAgentWallet";
export type VaultResourceFormTab = "secret" | "profileCard" | "stripeAgentWallet";
export type VaultWorkspaceTab = "secrets" | "grants" | "setup";

export interface VaultKeyMetaLike {
  key: string;
  description?: string | null;
  userOnly?: boolean;
  resourceKind?: VaultResourceKind;
  resourceSummary?: string | null;
  resourceProvider?: string | null;
  resourceFields?: string[];
}

export const VAULT_RESOURCE_FORM_TABS: Array<{
  id: VaultResourceFormTab;
  label: string;
  countKind: VaultResourceKind;
}> = [
  { id: "secret", label: "Passwords & keys", countKind: "secret" },
  { id: "profileCard", label: "Profile cards", countKind: "profileCard" },
  { id: "stripeAgentWallet", label: "Agent wallets", countKind: "stripeAgentWallet" },
];

export const PERMISSION_LEVELS: Array<{
  level: PermissionLevel;
  label: string;
  title: string;
}> = [
  {
    level: "userOnly",
    label: "User only",
    title: "Only the user can see this secret. Agents cannot see its name, description, or value.",
  },
  {
    level: "visible",
    label: "Visible / ask",
    title: "Agents can see safe metadata for planning and can ask to use this secret. Values stay hidden until approved.",
  },
  {
    level: "browserFillAlways",
    label: "Fill by site",
    title: "Agents may use this resource through ShellX Browser only on the exact website origin you approve.",
  },
  {
    level: "toolUseAlways",
    label: "Tool use always",
    title: "Agents may use this resource through mediated ShellX tools without raw reveal.",
  },
];

export function activeGrantsBySecretRef(grants: GrantSummary[], now = Date.now()): Map<string, GrantSummary[]> {
  const grouped = new Map<string, GrantSummary[]>();
  for (const grant of grants) {
    if (!grant.approved) continue;
    if (grant.revoked) continue;
    if (grant.expiresAtMs && grant.expiresAtMs <= now) continue;
    const existing = grouped.get(grant.secretRef) ?? [];
    existing.push(grant);
    grouped.set(grant.secretRef, existing);
  }
  return grouped;
}

export function groupVaultEntriesByResourceKind<T extends VaultKeyMetaLike>(
  entries: T[],
): Record<VaultResourceKind, T[]> {
  const groups: Record<VaultResourceKind, T[]> = {
    secret: [],
    profileCard: [],
    emailInbox: [],
    stripeAgentWallet: [],
  };
  for (const entry of entries) {
    groups[resourceKindOf(entry)].push(entry);
  }
  return groups;
}

export function permissionLevelForEntry(entry: VaultKeyMetaLike, activeGrants: GrantSummary[]): PermissionLevel {
  if (entry.userOnly) return "userOnly";
  const operations = new Set(
    activeGrants
      .map((grant) => normalizeGrantOperation(grant.operation))
      .filter((operation): operation is GrantOperation => Boolean(operation)),
  );
  if (
    operations.has("providerUse") ||
    operations.has("connectorUse") ||
    operations.has("injectEnv") ||
    operations.has("deposit")
  ) {
    return "toolUseAlways";
  }
  if (
    operations.has("fill") ||
    operations.has("profileFill") ||
    operations.has("emailCodeRead") ||
    operations.has("agentWalletUse")
  ) return "browserFillAlways";
  return "visible";
}

export function desiredGrantOperationsForLevel(
  level: PermissionLevel,
  resourceKind: VaultResourceKind = "secret",
): GrantOperation[] {
  switch (level) {
    case "browserFillAlways":
      switch (resourceKind) {
        case "profileCard":
          return ["profileFill"];
        case "emailInbox":
          return ["emailCodeRead"];
        case "stripeAgentWallet":
          return ["agentWalletUse"];
        case "secret":
          return ["fill"];
      }
    case "toolUseAlways":
      switch (resourceKind) {
        case "profileCard":
          return ["providerUse"];
        case "emailInbox":
          return ["providerUse"];
        case "stripeAgentWallet":
          return ["connectorUse"];
        case "secret":
          return ["providerUse"];
      }
    case "userOnly":
    case "visible":
      return [];
  }
}

export function normalizeGrantOperation(operation: string): GrantOperation | null {
  switch (operation) {
    case "Fill":
    case "fill":
      return "fill";
    case "ProfileFill":
    case "profileFill":
      return "profileFill";
    case "EmailCodeRead":
    case "emailCodeRead":
      return "emailCodeRead";
    case "AgentWalletUse":
    case "agentWalletUse":
      return "agentWalletUse";
    case "InjectEnv":
    case "injectEnv":
      return "injectEnv";
    case "ProviderUse":
    case "providerUse":
      return "providerUse";
    case "ConnectorUse":
    case "connectorUse":
      return "connectorUse";
    case "Deposit":
    case "deposit":
      return "deposit";
    case "RawReveal":
    case "rawReveal":
      return "rawReveal";
    default:
      return null;
  }
}

export function countActiveGrants(grants: GrantSummary[], now = Date.now()): number {
  return grants.filter((grant) => grant.approved && !grant.revoked && (!grant.expiresAtMs || grant.expiresAtMs > now)).length;
}

export function permissionLevelLabel(level: PermissionLevel): string {
  return PERMISSION_LEVELS.find((option) => option.level === level)?.label ?? level;
}

export function resourceKindOf(entry: VaultKeyMetaLike): VaultResourceKind {
  switch (entry.resourceKind) {
    case "profileCard":
    case "stripeAgentWallet":
    case "secret":
      return entry.resourceKind;
    case "emailInbox":
      return "secret";
    default:
      return "secret";
  }
}

export function resourceKindTitle(kind: VaultResourceKind): string {
  switch (kind) {
    case "profileCard":
      return "profile card";
    case "emailInbox":
      return "email inbox";
    case "stripeAgentWallet":
      return "agent wallet";
    case "secret":
      return "secret";
  }
}

export function slug(value: string): string {
  const slugged = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slugged || "resource";
}

export function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function resourceFieldsFromObject(values: Record<string, string>): string[] {
  return Object.entries(values)
    .filter(([, value]) => value.trim().length > 0)
    .map(([key]) => key);
}

export function profileResourceSummary(values: Record<string, string | boolean>): string {
  const fields = resourceFieldsFromObject({
    fullName: String(values.fullName ?? ""),
    email: String(values.email ?? ""),
    username: String(values.username ?? ""),
    company: String(values.company ?? ""),
    role: String(values.role ?? ""),
    phone: String(values.phone ?? ""),
    address: [
      values.addressLine1,
      values.addressLine2,
      values.city,
      values.region,
      values.postalCode,
      values.country,
    ]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .join(" "),
  });
  if (fields.length === 0) return "empty profile card";
  return `${fields.length} field${fields.length === 1 ? "" : "s"}`;
}
