import assert from "node:assert/strict";
import {
  CONNECTOR_PROVIDERS,
  connectorLabelForSave,
  filterOutsideConnectorEvents,
  summarizeOutsideConnectorInbox,
} from "../src/lib/outside-connectors";

assert.deepEqual(CONNECTOR_PROVIDERS, ["telegram", "discord"]);

const summary = summarizeOutsideConnectorInbox(
  [
    { enabled: false, provider: { kind: "telegram" } },
    { enabled: true, provider: { kind: "discord" } },
  ],
  [
    { id: "evt-1", status: "inbox", createdMs: 1_000 },
    { id: "evt-2", status: "rejected", createdMs: 2_000 },
    { id: "evt-3", status: "autoPrompt", createdMs: 3_000 },
  ],
);

assert.equal(summary.enabledCount, 1);
assert.equal(summary.eventCount, 3);
assert.equal(summary.unreadCount, 3);
assert.equal(summary.inboxCount, 1);
assert.equal(summary.rejectedCount, 1);
assert.equal(summary.shouldShowHeaderInbox, true);
assert.equal(summary.label, "1 connector");
assert.equal(summary.badgeLabel, "3");

const seenSummary = summarizeOutsideConnectorInbox(
  [{ enabled: true, provider: { kind: "telegram" } }],
  [
    { id: "old", status: "inbox", createdMs: 1_000 },
    { id: "new", status: "inbox", createdMs: 3_000 },
  ],
  2_000,
);
assert.equal(seenSummary.eventCount, 2);
assert.equal(seenSummary.unreadCount, 1);
assert.equal(seenSummary.badgeLabel, "1");

const readSummary = summarizeOutsideConnectorInbox(
  [{ enabled: true, provider: { kind: "telegram" } }],
  [{ id: "old", status: "inbox", createdMs: 1_000 }],
  1_000,
);
assert.equal(readSummary.eventCount, 1);
assert.equal(readSummary.unreadCount, 0);
assert.equal(readSummary.badgeLabel, "");

const pausedWithHistory = summarizeOutsideConnectorInbox(
  [{ enabled: false, provider: { kind: "telegram" } }],
  [{ id: "old", status: "inbox", createdMs: 1_000 }],
  1_000,
);
assert.equal(pausedWithHistory.shouldShowHeaderInbox, true);
assert.equal(pausedWithHistory.label, "1 connector");

const emptySummary = summarizeOutsideConnectorInbox([], []);
assert.equal(emptySummary.enabledCount, 0);
assert.equal(emptySummary.eventCount, 0);
assert.equal(emptySummary.unreadCount, 0);
assert.equal(emptySummary.inboxCount, 0);
assert.equal(emptySummary.rejectedCount, 0);
assert.equal(emptySummary.shouldShowHeaderInbox, false);
assert.equal(emptySummary.label, "No connectors");
assert.equal(emptySummary.badgeLabel, "");

assert.equal(connectorLabelForSave("telegram", "Ops Telegram"), "Ops Telegram");
assert.equal(connectorLabelForSave("discord", ""), "Discord");

const filtered = filterOutsideConnectorEvents(
  [
    {
      id: "tg-old",
      connectorLabel: "Telegram",
      provider: "telegram",
      status: "inbox",
      senderId: "1234567890",
      conversationId: "1234567890",
      guildId: null,
      target: "active tab",
      textPreview: "Deploy report",
      externalPreview: "Deploy report",
      reason: null,
      createdMs: new Date("2026-05-26T09:30:00").getTime(),
    },
    {
      id: "dc-new",
      connectorLabel: "Discord",
      provider: "discord",
      status: "rejected",
      senderId: "user:111222333444555666",
      conversationId: "dm:1",
      guildId: null,
      target: "active tab",
      textPreview: "status ping",
      externalPreview: "status ping",
      reason: "not allowed",
      createdMs: new Date("2026-05-27T11:00:00").getTime(),
    },
  ],
  { provider: "discord", query: "ping", localDate: "2026-05-27" },
);
assert.deepEqual(filtered.map((event) => event.id), ["dc-new"]);
