import { createHash } from "node:crypto";

type Connection = { base: string; token: string };

type ClipboardResponse = {
  ok: boolean;
  action: string;
  empty: boolean;
  leaseId?: string;
  verified?: boolean;
  cleared?: boolean;
};

export type ClipboardLifecycleLease = {
  leaseId: string;
  expectedSha256: string;
  expectedBytes: number;
};

export function clipboardExpectedMetadata(value: string): Pick<ClipboardLifecycleLease, "expectedSha256" | "expectedBytes"> {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > 256 * 1024) throw new Error("owned clipboard fixture length is outside the bounded lifecycle");
  return {
    expectedSha256: createHash("sha256").update(value, "utf8").digest("hex"),
    expectedBytes: bytes,
  };
}

export async function preflightClipboardLifecycle(
  connection: Connection,
  expectedValue: string,
): Promise<ClipboardLifecycleLease> {
  const metadata = clipboardExpectedMetadata(expectedValue);
  const response = await clipboardRequest(connection, { action: "preflight" });
  if (!response.ok || response.action !== "preflight" || response.empty !== true
    || typeof response.leaseId !== "string" || !/^rcb-[a-f0-9]{32}$/.test(response.leaseId)) {
    throw new Error("native clipboard preflight did not return an exact empty lease");
  }
  return { leaseId: response.leaseId, ...metadata };
}

export async function verifyAndClearClipboardLifecycle(
  connection: Connection,
  lease: ClipboardLifecycleLease,
): Promise<void> {
  const expected = {
    leaseId: lease.leaseId,
    expectedSha256: lease.expectedSha256,
    expectedBytes: lease.expectedBytes,
  };
  const verified = await clipboardRequest(connection, { action: "verify", ...expected });
  if (!verified.ok || verified.action !== "verify" || verified.verified !== true || verified.empty !== false) {
    throw new Error("native clipboard verification did not match the owned fixture");
  }
  const cleared = await clipboardRequest(connection, { action: "clear", ...expected });
  if (!cleared.ok || cleared.action !== "clear" || cleared.cleared !== true || cleared.empty !== true) {
    throw new Error("native clipboard cleanup did not prove empty");
  }
}

export async function releaseUnusedClipboardLifecycle(
  connection: Connection,
  lease: ClipboardLifecycleLease,
): Promise<void> {
  const released = await clipboardRequest(connection, {
    action: "releaseEmpty",
    leaseId: lease.leaseId,
  });
  if (!released.ok || released.action !== "releaseEmpty" || released.empty !== true) {
    throw new Error("unused native clipboard lease was not released from an empty clipboard");
  }
}

export async function abandonClipboardLifecycle(
  connection: Connection,
  lease: ClipboardLifecycleLease,
): Promise<void> {
  const abandoned = await clipboardRequest(connection, {
    action: "abandon",
    leaseId: lease.leaseId,
  });
  if (!abandoned.ok || abandoned.action !== "abandon" || abandoned.empty !== false) {
    throw new Error("native clipboard lease was not abandoned without touching clipboard state");
  }
}

async function clipboardRequest(
  connection: Connection,
  body: Record<string, unknown>,
): Promise<ClipboardResponse> {
  const response = await fetch(`${connection.base}/release-test/clipboard`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const value = await response.json().catch(() => null) as ClipboardResponse | { error?: unknown } | null;
  if (!response.ok) {
    const errorValue = value && typeof value === "object" && "error" in value ? value.error : undefined;
    const code = typeof errorValue === "string" ? errorValue : "unknown";
    throw new Error(`native clipboard lifecycle refused ${String(body.action)} (${response.status} ${code})`);
  }
  if (!value || typeof value !== "object") throw new Error("native clipboard lifecycle returned a non-object");
  return value as ClipboardResponse;
}
