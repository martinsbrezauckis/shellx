export interface TaskAttachmentReference {
  attachmentId: string;
  digest: string;
}

export interface TaskAttachmentPersistenceReceipt {
  receiptId: string;
  attachmentId: string;
  digest: string;
  targetKey: string;
  sizeBytes: number;
  createdAtMs: number;
}

export interface TaskAttachmentPersistenceResponse {
  targetKey: string;
  attachments: TaskAttachmentReference[];
  receipts: TaskAttachmentPersistenceReceipt[];
}

export interface TaskAttachmentReclamationResponse {
  selectedAttachmentIds: string[];
  reclaimedAttachmentIds: string[];
  pendingAttachmentIds: string[];
}

const ATTACHMENT_ID = /^task-attachment:v1:[a-f0-9]{64}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseTaskAttachmentPersistenceResponse(
  value: unknown,
  expectedCount: number,
): TaskAttachmentPersistenceResponse {
  if (!isRecord(value) || !bounded(value.targetKey, 512)) {
    throw new Error("ShellX returned an invalid Task attachment target receipt.");
  }
  const targetKey = value.targetKey;
  if (!Array.isArray(value.attachments) || !Array.isArray(value.receipts)
    || value.attachments.length !== expectedCount || value.receipts.length !== expectedCount) {
    throw new Error("ShellX returned an incomplete Task attachment receipt set.");
  }
  const seen = new Set<string>();
  const attachments = value.attachments.map((candidate) => {
    if (!isRecord(candidate)
      || typeof candidate.attachmentId !== "string"
      || !ATTACHMENT_ID.test(candidate.attachmentId)
      || typeof candidate.digest !== "string"
      || !SHA256.test(candidate.digest)
      || seen.has(candidate.attachmentId)) {
      throw new Error("ShellX returned an invalid durable Task attachment identity.");
    }
    seen.add(candidate.attachmentId);
    return { attachmentId: candidate.attachmentId, digest: candidate.digest };
  });
  const references = new Map(attachments.map((attachment) => [attachment.attachmentId, attachment.digest]));
  const seenReceiptIds = new Set<string>();
  const seenReceiptAttachments = new Set<string>();
  const receipts = value.receipts.map((candidate) => {
    if (!isRecord(candidate)
      || typeof candidate.receiptId !== "string" || !UUID.test(candidate.receiptId)
      || seenReceiptIds.has(candidate.receiptId)
      || typeof candidate.attachmentId !== "string"
      || seenReceiptAttachments.has(candidate.attachmentId)
      || typeof candidate.digest !== "string"
      || references.get(candidate.attachmentId) !== candidate.digest
      || candidate.targetKey !== targetKey
      || typeof candidate.sizeBytes !== "number" || !Number.isSafeInteger(candidate.sizeBytes) || candidate.sizeBytes <= 0 || candidate.sizeBytes > 25 * 1024 * 1024
      || typeof candidate.createdAtMs !== "number" || !Number.isSafeInteger(candidate.createdAtMs) || candidate.createdAtMs <= 0) {
      throw new Error("ShellX returned an invalid Task attachment persistence receipt.");
    }
    seenReceiptIds.add(candidate.receiptId);
    seenReceiptAttachments.add(candidate.attachmentId);
    return {
      receiptId: candidate.receiptId,
      attachmentId: candidate.attachmentId,
      digest: candidate.digest,
      targetKey,
      sizeBytes: candidate.sizeBytes,
      createdAtMs: candidate.createdAtMs,
    };
  });
  if (seenReceiptAttachments.size !== references.size) {
    throw new Error("ShellX returned an incomplete Task attachment persistence receipt set.");
  }
  return { targetKey, attachments, receipts };
}

export function parseTaskAttachmentReclamationResponse(
  value: unknown,
  expectedAttachmentIds: string[],
): TaskAttachmentReclamationResponse {
  if (!isRecord(value)
    || !Array.isArray(value.selectedAttachmentIds)
    || !Array.isArray(value.reclaimedAttachmentIds)
    || !Array.isArray(value.pendingAttachmentIds)) {
    throw new Error("ShellX returned an invalid Task attachment reclamation receipt.");
  }
  const expected = new Set(expectedAttachmentIds);
  if (expected.size !== expectedAttachmentIds.length
    || expectedAttachmentIds.some((id) => !ATTACHMENT_ID.test(id))) {
    throw new Error("The Task attachment reclamation request is invalid.");
  }
  const selectedAttachmentIds = validateReclamationIds(value.selectedAttachmentIds, expected);
  if (selectedAttachmentIds.length !== expected.size) {
    throw new Error("ShellX returned an incomplete Task attachment reclamation receipt.");
  }
  const reclaimedAttachmentIds = validateReclamationIds(value.reclaimedAttachmentIds, expected);
  const pendingAttachmentIds = validateReclamationIds(value.pendingAttachmentIds, expected);
  const observed = new Set([...reclaimedAttachmentIds, ...pendingAttachmentIds]);
  if (observed.size !== expected.size
    || reclaimedAttachmentIds.some((id) => pendingAttachmentIds.includes(id))) {
    throw new Error("ShellX returned an incomplete Task attachment reclamation receipt.");
  }
  return { selectedAttachmentIds, reclaimedAttachmentIds, pendingAttachmentIds };
}

export function parseTaskAttachmentMaintenanceResponse(
  value: unknown,
): TaskAttachmentReclamationResponse {
  if (!isRecord(value) || !Array.isArray(value.selectedAttachmentIds)
    || value.selectedAttachmentIds.length > 16
    || value.selectedAttachmentIds.some((id) => typeof id !== "string" || !ATTACHMENT_ID.test(id))) {
    throw new Error("ShellX returned an invalid Task attachment maintenance receipt.");
  }
  return parseTaskAttachmentReclamationResponse(
    value,
    value.selectedAttachmentIds as string[],
  );
}

function validateReclamationIds(value: unknown[], expected: Set<string>): string[] {
  const seen = new Set<string>();
  return value.map((candidate) => {
    if (typeof candidate !== "string" || !ATTACHMENT_ID.test(candidate)
      || !expected.has(candidate) || seen.has(candidate)) {
      throw new Error("ShellX returned an invalid Task attachment reclamation receipt.");
    }
    seen.add(candidate);
    return candidate;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
}
