import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentCliSetupDialog } from "../src/components/AgentCliSetupAssistant";
import { AgentCliStatusCard } from "../src/components/AgentCliStatusCard";
import {
  DEBUG_AGENT_CLI_SETUP_PRESET,
  debugAgentCliSetupFixture,
} from "../src/lib/debug-agent-cli-setup-fixture";

const cards = renderToStaticMarkup(createElement(AgentCliSetupDialog, {
  preset: DEBUG_AGENT_CLI_SETUP_PRESET,
  onClose: () => {},
  fixture: debugAgentCliSetupFixture("cards"),
}));
assert(cards.includes('data-debug-id="agent-cli-setup-dialog"'));
assert(cards.includes('data-debug-id="agent-cli-setup-assistant"'));
assert(cards.includes('data-debug-id="surface-components-agentclisetupassistant-11"'));
assert(cards.includes('data-debug-id="surface-components-agentclisetupassistant-5"'));
assert.equal(cards.includes('data-debug-id="agent-cli-setup-confirm"'), false);
assert.equal((cards.match(/disabled=""/g) ?? []).length, 3);
assert.match(cards, /<button[^>]*>Close<\/button>/);
assert.equal(debugAgentCliSetupFixture("cards").allowOwnedExternal, true);

assert.deepEqual(
  debugAgentCliSetupFixture("status-card").state.providers.map((provider) => provider.providerId),
  ["grok", "claude-code", "codex-cli", "antigravity-cli"],
  "the status-card fixture exposes exactly the four supported Agent CLI providers",
);
const statusCard = renderToStaticMarkup(createElement(AgentCliStatusCard, {
  activeTabId: "owned-status-fixture-tab",
  sessionInfo: null,
  connectionId: null,
  connectionTransport: "local",
  connectionPreset: null,
  fixture: debugAgentCliSetupFixture("status-card"),
}));
for (const providerId of ["grok", "claude-code", "codex-cli", "antigravity-cli"]) {
  assert(
    statusCard.includes(`data-debug-id="agent-cli-setup-open-${providerId}"`),
    `the inert status card must render the exact ${providerId} setup control`,
  );
}
assert(statusCard.includes('data-debug-id="agent-cli-setup-open-missing"'));

const confirmation = renderToStaticMarkup(createElement(AgentCliSetupDialog, {
  preset: DEBUG_AGENT_CLI_SETUP_PRESET,
  onClose: () => {},
  fixture: debugAgentCliSetupFixture("confirmation"),
}));
assert(confirmation.includes('data-debug-id="agent-cli-setup-confirm"'));
assert(confirmation.includes('data-debug-id="surface-components-agentclisetupassistant-9"'));
assert.equal((confirmation.match(/disabled=""/g) ?? []).length, 6);
assert.match(confirmation, /<button[^>]*>Close<\/button>/);
assert.equal(debugAgentCliSetupFixture("confirmation").allowOwnedExternal, true);

const installLifecycle = renderToStaticMarkup(createElement(AgentCliSetupDialog, {
  preset: DEBUG_AGENT_CLI_SETUP_PRESET,
  onClose: () => {},
  fixture: debugAgentCliSetupFixture("install-lifecycle"),
}));
assert(installLifecycle.includes('data-agent-cli-provider="codex-cli"'));
assert(installLifecycle.includes('data-debug-id="surface-components-agentclisetupassistant-5"'));
assert.match(installLifecycle, /<button[^>]*>Install<\/button>/);
assert.equal(debugAgentCliSetupFixture("install-lifecycle").allowOwnedInstall, true);
assert.equal(debugAgentCliSetupFixture("install-lifecycle").state.providers[0]?.recommendedMethodId, "npm");
assert.equal(debugAgentCliSetupFixture("install-lifecycle").state.providers[0]?.installMethods[0]?.command, "npm install -g @openai/codex");

console.log("Agent CLI setup inert renderer fixtures passed");
