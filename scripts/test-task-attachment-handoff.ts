import assert from "node:assert/strict";
import {
  parseTaskAttachmentPersistenceResponse,
  parseTaskAttachmentMaintenanceResponse,
  parseTaskAttachmentReclamationResponse,
} from "../src/lib/task-attachment-handoff";

const attachmentId = `task-attachment:v1:${"a".repeat(64)}`;
const digest = `sha256:${"b".repeat(64)}`;
const receiptId = "123e4567-e89b-42d3-a456-426614174000";
const valid = {
  targetKey: "local:linux",
  attachments: [{ attachmentId, digest }],
  receipts: [{ receiptId, attachmentId, digest, targetKey: "local:linux", sizeBytes: 42, createdAtMs: 1 }],
};

assert.deepEqual(parseTaskAttachmentPersistenceResponse(valid, 1), valid);
assert.throws(() => parseTaskAttachmentPersistenceResponse({ ...valid, attachments: [] }, 1), /incomplete/);
assert.throws(() => parseTaskAttachmentPersistenceResponse({
  ...valid,
  attachments: [{ attachmentId: "asset-42", digest }],
}, 1), /invalid durable/);
assert.throws(() => parseTaskAttachmentPersistenceResponse({
  ...valid,
  receipts: [{ ...valid.receipts[0], targetKey: "ssh:other" }],
}, 1), /invalid Task attachment persistence/);

const secondAttachmentId = `task-attachment:v1:${"c".repeat(64)}`;
const secondDigest = `sha256:${"d".repeat(64)}`;
assert.throws(() => parseTaskAttachmentPersistenceResponse({
  targetKey: "local:linux",
  attachments: [valid.attachments[0], { attachmentId: secondAttachmentId, digest: secondDigest }],
  receipts: [valid.receipts[0], { ...valid.receipts[0], receiptId: "223e4567-e89b-42d3-a456-426614174000" }],
}, 2), /invalid Task attachment persistence/);

assert.deepEqual(parseTaskAttachmentReclamationResponse({
  selectedAttachmentIds: [attachmentId, secondAttachmentId],
  reclaimedAttachmentIds: [attachmentId],
  pendingAttachmentIds: [secondAttachmentId],
}, [attachmentId, secondAttachmentId]), {
  selectedAttachmentIds: [attachmentId, secondAttachmentId],
  reclaimedAttachmentIds: [attachmentId],
  pendingAttachmentIds: [secondAttachmentId],
});
assert.throws(() => parseTaskAttachmentReclamationResponse({
  selectedAttachmentIds: [attachmentId, secondAttachmentId],
  reclaimedAttachmentIds: [attachmentId],
  pendingAttachmentIds: [attachmentId],
}, [attachmentId, secondAttachmentId]), /incomplete/);
assert.deepEqual(parseTaskAttachmentMaintenanceResponse({
  selectedAttachmentIds: [],
  reclaimedAttachmentIds: [],
  pendingAttachmentIds: [],
}), {
  selectedAttachmentIds: [],
  reclaimedAttachmentIds: [],
  pendingAttachmentIds: [],
});

console.log("Task attachment handoff passed: exact identities, receipt parity, and path-free response validation.");
