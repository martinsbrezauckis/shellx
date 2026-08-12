import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readRustModuleFamily } from "./read-rust-module-family";

import {
  findModelInstructionCard,
  isExplicitOnlyCard,
  modelInstructionCardsPath,
  requiredPreflightIds,
  type ModelInstructionCardsState,
} from "../src/lib/model-instruction-cards";

const sampleState: ModelInstructionCardsState = {
  version: "test",
  lastReviewed: "2026-06-03",
  policy: {
    shellxMayAutoRoute: false,
    defaultRouteMode: "explicitOnly",
    defaultToolExposureMode: "nativeFirst",
    toolExposureModes: [
      {
        id: "nativeFirst",
        label: "Native First",
        description: "Prefer provider-native tools.",
        agentRule: "Use ShellX host tools only for explicit bridge work.",
      },
    ],
    fallbackRule: "Ask before fallback.",
    operatorRule: "Attach notes while work is running.",
  },
  cards: [
    {
      id: "grok-imagine-video",
      displayName: "Grok Imagine Video",
      providerId: "grok",
      category: "media-generation",
      status: "bundled",
      routeMode: "explicitOnly",
      shellxMayAutoRoute: false,
      intentExamples: ["generate video with Grok Imagine"],
      preflightChecks: [
        { id: "grokConnected", label: "Active Grok session is connected", required: true },
        { id: "grokToolsHealthy", label: "Grok tools are visible", required: true },
        { id: "previewTargetKnown", label: "Preview target is known", required: false },
      ],
      capabilities: [
        {
          id: "videoGeneration",
          label: "Video generation",
          level: "native",
          notes: "Use Grok's own media surface.",
        },
      ],
      toolExposure: {
        defaultMode: "hostBridge",
        nativeToolRule: "Use Grok's native media tools.",
        shellxToolRule: "Use ShellX only for handoff and receipts.",
        allowedShellxTools: ["send_prompt_to_session", "session_tooling"],
      },
      invocation: {
        surface: "active-grok-session",
        debugApiPath: "/state/session_tooling",
        requiresUserVisibleSelection: true,
      },
      agentInstructions: ["Do not silently fall back."],
      receiptKinds: ["media-requested", "provider-health-checked"],
      fallbackRule: "Ask the user before using another video provider.",
      provenance: {
        source: "bundled-shellx-card",
        refreshHint: "Refresh from provider lab probes.",
      },
    },
  ],
};

assert.equal(modelInstructionCardsPath(), "/state/model_instruction_cards");

const card = findModelInstructionCard(sampleState, "grok-imagine-video");
assert(card, "finds grok image/video card");
assert.equal(isExplicitOnlyCard(card), true);
assert.deepEqual(requiredPreflightIds(card), ["grokConnected", "grokToolsHealthy"]);

const debugApiSource = readRustModuleFamily("src-tauri/src/debug_api.rs");
assert(
  debugApiSource.includes("\"/state/model_instruction_cards\""),
  "debug API must wire /state/model_instruction_cards",
);
assert(
  debugApiSource.includes("state_model_instruction_cards"),
  "debug API must expose model instruction card handler",
);

const apiDocs = readFileSync(new URL("../docs/public/API.md", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
assert(
  apiDocs.includes("GET /state/model_instruction_cards"),
  "API docs must document model instruction card route",
);
assert(
  apiDocs.includes("ShellX does not silently route"),
  "API docs must state no silent provider routing",
);
assert(
  apiDocs.includes("send_prompt_to_provider"),
  "API docs must document explicit provider handoff tool",
);

const rightRailSource = readFileSync(
  new URL("../src/components/RightRail.tsx", import.meta.url),
  "utf8",
);
const cardsApiSource = readFileSync(
  new URL("../src/lib/model-instruction-cards-api.ts", import.meta.url),
  "utf8",
);
assert(
  cardsApiSource.includes('from "./debug-api"') &&
    cardsApiSource.includes("getModelInstructionCards") &&
    !readFileSync(new URL("../src/lib/model-instruction-cards.ts", import.meta.url), "utf8")
      .includes('import("./debug-api")'),
  "Model instruction contracts must stay separate from the operational Debug API client",
);
assert(
  rightRailSource.includes("getModelInstructionCards"),
  "Tools pane must fetch model instruction cards",
);
assert(
  rightRailSource.includes("ModelInstructionCardsCard"),
  "Tools pane must render the model instruction cards card",
);
assert(
  rightRailSource.includes("no silent fallback"),
  "Tools pane must expose the no silent fallback policy",
);
assert(
  rightRailSource.includes("model-card-status"),
  "Tools pane must show model card status instead of unexplained requirement counts",
);
assert(
  rightRailSource.includes("model-card-mode") && rightRailSource.includes("formatToolExposureMode"),
  "Tools pane must show compact provider tool exposure modes",
);
assert(
  !rightRailSource.includes("requiredChecks"),
  "Tools pane must not show per-card required-check counts in the compact list",
);
assert(
  !rightRailSource.includes("category.count"),
  "Tools pane category summary must not show unexplained numeric counts",
);

const cardsSource = readFileSync(
  new URL("../src-tauri/src/model_instruction_cards.rs", import.meta.url),
  "utf8",
);
const providerHandoffSource = readFileSync(
  new URL("../src-tauri/src/host_mcp/provider_handoff_cli.rs", import.meta.url),
  "utf8",
);
const hostMcpToolSpecsSource = readFileSync(
  new URL("../src-tauri/src/host_mcp/tool_specs_core.rs", import.meta.url),
  "utf8",
);
assert(
  cardsSource.includes('MODEL_INSTRUCTION_CARDS_VERSION: &str = "2026-08-11.1"') &&
    cardsSource.includes('MODEL_INSTRUCTION_CARDS_REVIEWED_ON: &str = "2026-08-11"'),
  "runtime model instruction card metadata must reflect the current reviewed recipe set",
);
assert(
  cardsSource.includes("default_tool_exposure_mode: \"nativeFirst\"") &&
    cardsSource.includes("Native First") &&
    cardsSource.includes("Host Bridge") &&
    cardsSource.includes("Host Full") &&
    cardsSource.includes("Off"),
  "runtime model instruction card policy must expose ShellX tool exposure modes",
);
assert(
  cardsSource.includes("Use the selected coding agent's native terminal, file, patch, and MCP tools") &&
    cardsSource.includes("Use ShellX only for explicit user-approved handoff"),
  "cards must distinguish provider-native tools from explicit ShellX host bridge tools",
);
assert(
  cardsSource.includes("send_prompt_to_provider") &&
    cardsSource.includes("providerId=codex-cli"),
  "Codex/GPT Image cards must instruct agents to use explicit provider handoff",
);
assert(
  cardsSource.includes("GPT Image recipe") &&
    cardsSource.includes("Do not run codex exec directly") &&
    cardsSource.includes("Do not set timeoutMs below"),
  "Codex/GPT Image card must include an immediate recipe and timeout/raw-cli guardrails",
);
assert(
  cardsSource.includes("Grok Imagine image recipe") &&
    cardsSource.includes("Grok Imagine video recipe") &&
    cardsSource.includes("send_prompt_to_session"),
  "Grok Imagine image/video cards must include explicit ShellX handoff recipes",
);
assert(
  cardsSource.includes("antigravity-nano-banana-image") &&
    cardsSource.includes('display_name: "Antigravity Image Generation"') &&
    cardsSource.includes('provider_id: "antigravity-cli"') &&
    cardsSource.includes('status: "bundled"') &&
    cardsSource.includes("generate_image") &&
    cardsSource.includes("includeShellxTooling=false") &&
    cardsSource.includes("already-running Antigravity session") &&
    cardsSource.includes("do not hand off to Antigravity from Antigravity") &&
    cardsSource.includes(
      '"nativeFirst",\n        "In an already-running Antigravity session, use native generate_image directly',
    ),
  "Antigravity image card must use native generate_image directly and reserve the ShellX bridge for another provider session",
);
assert(
  hostMcpToolSpecsSource.includes('"includeShellxTooling": { "type": "boolean"') &&
    hostMcpToolSpecsSource.includes("Defaults true for generic coding-agent handoffs") &&
    providerHandoffSource.includes("provider_handoff_include_shellx_tooling") &&
    providerHandoffSource.includes('"includeShellxTooling": options.include_shellx_tooling'),
  "provider handoff must advertise and forward optional target-session ShellX tooling control",
);
assert(
  cardsSource.includes("antigravity-video-generation") &&
    cardsSource.includes('display_name: "Antigravity Video Generation"') &&
    cardsSource.includes('status: "provider-unavailable"') &&
    cardsSource.includes("provider-capability-boundary") &&
    cardsSource.includes("do not launch Antigravity solely for this unsupported request") &&
    cardsSource.includes("WebM recording") &&
    cardsSource.includes("command_hint: None"),
  "Antigravity video card must be explicitly unavailable without a launchable command hint",
);

const shellxHostSkill = readFileSync(
  new URL("../skills/shellx-host/SKILL.md", import.meta.url),
  "utf8",
);
assert(
  shellxHostSkill.includes("## Activation precondition") &&
    shellxHostSkill.includes("positively identifies this session as running inside ShellX") &&
    shellxHostSkill.includes("Global skill availability") &&
    shellxHostSkill.includes("Outside ShellX, do not invoke it"),
  "shellx-host skill must fail closed unless the current session has positive ShellX host evidence",
);
assert.doesNotMatch(
  shellxHostSkill,
  /Read this at session start|# You are running inside shellX/i,
  "shellx-host skill must not claim that an ordinary direct CLI session is hosted by ShellX",
);
assert(
  shellxHostSkill.includes("Media Handoff Recipes") &&
    shellxHostSkill.includes("GPT Image via Codex") &&
    shellxHostSkill.includes("Grok Imagine image") &&
    shellxHostSkill.includes("Grok Imagine video") &&
    shellxHostSkill.includes("Antigravity image generation") &&
    shellxHostSkill.includes("native `generate_image`") &&
    shellxHostSkill.includes("Antigravity video generation (unavailable)") &&
    shellxHostSkill.includes("Antigravity solely for this unsupported request") &&
    shellxHostSkill.includes("do not hand off to Antigravity from Antigravity") &&
    shellxHostSkill.includes("off/no-ShellX-tooling mode") &&
    shellxHostSkill.includes("per-tab rows merging active Grok ACP and\n  provider-session context"),
  "shellx-host skill must expose direct media handoff recipes in a confirmed ShellX host session",
);
assert(
  apiDocs.includes('providerId: "antigravity-cli"') &&
    apiDocs.includes("current native Antigravity CLI has no video-generation tool") &&
    apiDocs.includes("must\nnot launch Antigravity solely") &&
    apiDocs.includes("never hands off to itself") &&
    apiDocs.includes("off/no-ShellX-tooling mode"),
  "public API docs must describe the context-correct Antigravity image route and unavailable video boundary",
);
assert(
  readme.includes("Antigravity receives only isolated session rules") &&
    readme.includes("does\n  not receive the ShellX Host MCP surface") &&
    readme.includes("Host MCP bridge remains\n  disabled"),
  "README must not imply that Antigravity receives the disabled ShellX Host MCP bridge",
);

console.log("test-model-instruction-cards ok");
