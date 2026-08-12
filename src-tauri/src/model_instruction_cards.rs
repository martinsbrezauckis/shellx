//! Bundled instruction/capability cards for user-directed model routing.
//!
//! These cards are intentionally descriptive. ShellX exposes them to the UI and
//! agents so they know what a named provider/tool can do, how to preflight it,
//! and what evidence to record. ShellX must not silently choose another
//! provider when a user explicitly names one.

use serde::{Deserialize, Serialize};

pub const MODEL_INSTRUCTION_CARDS_VERSION: &str = "2026-08-11.1";
pub const MODEL_INSTRUCTION_CARDS_REVIEWED_ON: &str = "2026-08-11";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInstructionCardsState {
    pub version: String,
    pub last_reviewed: String,
    pub policy: ModelRoutingPolicySummary,
    pub cards: Vec<ModelInstructionCard>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRoutingPolicySummary {
    pub shellx_may_auto_route: bool,
    pub default_route_mode: String,
    pub default_tool_exposure_mode: String,
    pub tool_exposure_modes: Vec<ToolExposureModeSummary>,
    pub fallback_rule: String,
    pub operator_rule: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolExposureModeSummary {
    pub id: String,
    pub label: String,
    pub description: String,
    pub agent_rule: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInstructionCard {
    pub id: String,
    pub display_name: String,
    pub provider_id: String,
    pub category: String,
    pub status: String,
    pub route_mode: String,
    pub shellx_may_auto_route: bool,
    pub intent_examples: Vec<String>,
    pub preflight_checks: Vec<CardPreflightCheck>,
    pub capabilities: Vec<CardCapability>,
    pub tool_exposure: CardToolExposurePolicy,
    pub invocation: CardInvocation,
    pub agent_instructions: Vec<String>,
    pub receipt_kinds: Vec<String>,
    pub fallback_rule: String,
    pub provenance: CardProvenance,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardPreflightCheck {
    pub id: String,
    pub label: String,
    pub required: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardCapability {
    pub id: String,
    pub label: String,
    pub level: String,
    pub notes: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardToolExposurePolicy {
    pub default_mode: String,
    pub native_tool_rule: String,
    pub shellx_tool_rule: String,
    pub allowed_shellx_tools: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardInvocation {
    pub surface: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub debug_api_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub command_hint: Option<String>,
    pub requires_user_visible_selection: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardProvenance {
    pub source: String,
    pub refresh_hint: String,
}

pub fn model_instruction_cards_state() -> ModelInstructionCardsState {
    ModelInstructionCardsState {
        version: MODEL_INSTRUCTION_CARDS_VERSION.to_string(),
        last_reviewed: MODEL_INSTRUCTION_CARDS_REVIEWED_ON.to_string(),
        policy: ModelRoutingPolicySummary {
            shellx_may_auto_route: false,
            default_route_mode: "explicitOnly".to_string(),
            default_tool_exposure_mode: "nativeFirst".to_string(),
            tool_exposure_modes: tool_exposure_modes(),
            fallback_rule: "Do not use another provider or media tool unless the user explicitly approves the fallback.".to_string(),
            operator_rule: "When work is already running, attach user text as an operator note unless the user explicitly asks to interrupt or start a new run.".to_string(),
        },
        cards: vec![
            grok_imagine_video_card(),
            grok_imagine_image_card(),
            codex_gpt_image_card(),
            antigravity_nano_banana_image_card(),
            antigravity_video_generation_card(),
            codex_cli_card(),
            claude_code_card(),
            antigravity_cli_card(),
            shellx_preview_doctor_card(),
        ],
    }
}

fn grok_imagine_video_card() -> ModelInstructionCard {
    ModelInstructionCard {
        id: "grok-imagine-video".to_string(),
        display_name: "Grok Imagine Video".to_string(),
        provider_id: "grok".to_string(),
        category: "media-generation".to_string(),
        status: "bundled".to_string(),
        route_mode: "explicitOnly".to_string(),
        shellx_may_auto_route: false,
        intent_examples: vec![
            "generate video with Grok Imagine".to_string(),
            "animate this image using Grok Imagine".to_string(),
            "make a short video from this prompt with Grok".to_string(),
        ],
        preflight_checks: vec![
            preflight("grokConnected", "Grok session is connected or same-tab handoff can connect it", true),
            preflight("grokToolsHealthy", "Grok tools are visible in session tooling", true),
            preflight("mediaInputReady", "Prompt or source image is available", true),
        ],
        capabilities: vec![
            capability(
                "videoGeneration",
                "Video generation",
                "native",
                "Use Grok's own media surface when the user names Grok Imagine.",
            ),
            capability(
                "imageToVideo",
                "Image to video",
                "native",
                "Allowed when an image attachment or preview target is present.",
            ),
            capability(
                "toolStream",
                "Tool stream visibility",
                "observable",
                "ShellX can show receipts and session events it receives, but the provider owns media internals.",
            ),
        ],
        tool_exposure: media_handoff_tool_exposure("Grok Imagine video"),
        invocation: CardInvocation {
            surface: "grok-handoff-session".to_string(),
            debug_api_path: Some("/state/session_tooling".to_string()),
            command_hint: Some("Grok Imagine video recipe: call send_prompt_to_session with userApproved=true immediately; prompt Grok to use Grok Imagine video or image-to-video and to return the generated video path. Omit targetTabId for same-tab provider handoff; pass targetTabId only for a specific connected Grok tab.".to_string()),
            requires_user_visible_selection: true,
        },
        agent_instructions: vec![
            "Grok Imagine video recipe: when the user explicitly asks for Grok Imagine video, do not search or inspect provider docs first; call send_prompt_to_session with userApproved=true and include the user's video prompt verbatim.".to_string(),
            "Use this card only when the user explicitly asks for Grok Imagine video or approves that provider.".to_string(),
            "From Claude/Codex provider tabs, call send_prompt_to_session with userApproved=true so ShellX can connect or reuse the visible tab's Grok child before queueing the prompt.".to_string(),
            "Do not run raw grok commands, shell scripts, or other provider CLIs to bypass the ShellX handoff.".to_string(),
            "If Grok is disconnected or the media tool is unavailable, report the missing preflight instead of choosing another provider.".to_string(),
        ],
        receipt_kinds: vec![
            "media-requested".to_string(),
            "provider-health-checked".to_string(),
            "artifact-created".to_string(),
        ],
        fallback_rule: "Ask the user before using another video provider.".to_string(),
        provenance: bundled_provenance(),
    }
}

fn grok_imagine_image_card() -> ModelInstructionCard {
    ModelInstructionCard {
        id: "grok-imagine-image".to_string(),
        display_name: "Grok Imagine Image".to_string(),
        provider_id: "grok".to_string(),
        category: "media-generation".to_string(),
        status: "bundled".to_string(),
        route_mode: "explicitOnly".to_string(),
        shellx_may_auto_route: false,
        intent_examples: vec![
            "generate image with Grok Imagine".to_string(),
            "make this prompt as a Grok image".to_string(),
            "edit this image with Grok".to_string(),
        ],
        preflight_checks: vec![
            preflight("grokConnected", "Grok session is connected or same-tab handoff can connect it", true),
            preflight("grokToolsHealthy", "Grok tools are visible in session tooling", true),
            preflight("mediaInputReady", "Prompt or source image is available", true),
        ],
        capabilities: vec![
            capability(
                "imageGeneration",
                "Image generation",
                "native",
                "Use Grok's own image surface when the user names Grok Imagine.",
            ),
            capability(
                "imageEditing",
                "Image editing",
                "native",
                "Allowed when the user supplies an image and asks for an edit.",
            ),
            capability(
                "artifactPreview",
                "Artifact preview",
                "observable",
                "ShellX should preview generated files from the image board or chat stream when paths are available.",
            ),
        ],
        tool_exposure: media_handoff_tool_exposure("Grok Imagine image"),
        invocation: CardInvocation {
            surface: "grok-handoff-session".to_string(),
            debug_api_path: Some("/state/session_tooling".to_string()),
            command_hint: Some("Grok Imagine image recipe: call send_prompt_to_session with userApproved=true immediately; prompt Grok to use Grok Imagine image/editing and to return the generated image path. Omit targetTabId for same-tab provider handoff; pass targetTabId only for a specific connected Grok tab.".to_string()),
            requires_user_visible_selection: true,
        },
        agent_instructions: vec![
            "Grok Imagine image recipe: when the user explicitly asks for Grok Imagine image/editing, do not search or inspect provider docs first; call send_prompt_to_session with userApproved=true and include the user's image prompt verbatim.".to_string(),
            "Use this card only when the user explicitly names Grok Imagine image or approves that provider.".to_string(),
            "From Claude/Codex provider tabs, call send_prompt_to_session with userApproved=true so ShellX can connect or reuse the visible tab's Grok child before queueing the prompt.".to_string(),
            "Do not run raw grok commands, shell scripts, or another image provider to bypass the ShellX handoff.".to_string(),
            "Do not silently fall back to OpenAI image generation or another image provider.".to_string(),
        ],
        receipt_kinds: vec![
            "media-requested".to_string(),
            "provider-health-checked".to_string(),
            "artifact-created".to_string(),
        ],
        fallback_rule: "Ask the user before using another image provider.".to_string(),
        provenance: bundled_provenance(),
    }
}

fn codex_gpt_image_card() -> ModelInstructionCard {
    ModelInstructionCard {
        id: "codex-gpt-image".to_string(),
        display_name: "OpenAI GPT Image 2 via Codex".to_string(),
        provider_id: "codex-cli".to_string(),
        category: "media-generation".to_string(),
        status: "codex-routed".to_string(),
        route_mode: "explicitOnly".to_string(),
        shellx_may_auto_route: false,
        intent_examples: vec![
            "ask Codex to generate an image with GPT Image 2".to_string(),
            "edit this image using an OpenAI GPT Image model via Codex".to_string(),
            "use Codex image generation for this prompt".to_string(),
        ],
        preflight_checks: vec![
            preflight("codexAvailable", "Codex CLI is available in this environment", true),
            preflight("codexAuthReady", "Codex subscription/auth is ready", true),
            preflight("openAiImageToolReady", "Codex can access OpenAI image generation in this environment", true),
            preflight("mediaInputReady", "Prompt or source image is available", true),
        ],
        capabilities: vec![
            capability(
                "imageGeneration",
                "Image generation",
                "codex-routed",
                "Ask Codex to use OpenAI image generation only when the user explicitly names Codex or OpenAI image generation. With the Image API, gpt-image-2 is a valid image model.",
            ),
            capability(
                "imageEditing",
                "Image editing",
                "codex-routed",
                "Allowed when the user supplies an image and asks Codex to edit it with an available OpenAI GPT Image model such as gpt-image-2.",
            ),
            capability(
                "videoGeneration",
                "Video generation",
                "not-supported",
                "GPT Image models are image models, not video models.",
            ),
        ],
        tool_exposure: media_handoff_tool_exposure("GPT Image via Codex"),
        invocation: CardInvocation {
            surface: "provider-handoff-session".to_string(),
            debug_api_path: Some("/provider-sessions/start".to_string()),
            command_hint: Some("GPT Image recipe: call send_prompt_to_provider with providerId=codex-cli and userApproved=true immediately; omit targetTabId for same-tab handoff; ask Codex to use OpenAI image generation and return the image path. Do not create local placeholder images with PIL/canvas/SVG scripts. Do not set timeoutMs below 900000 for media. If using the Image API, model gpt-image-2 is valid. If using the Responses image_generation tool, use a supported mainline model and do not put gpt-image-2 in the Responses model field.".to_string()),
            requires_user_visible_selection: true,
        },
        agent_instructions: vec![
            "GPT Image recipe: when the user explicitly asks for GPT Image/OpenAI image generation, do not search docs or inspect Codex logs first; call send_prompt_to_provider with providerId=codex-cli and userApproved=true.".to_string(),
            "Use this card only when the user explicitly asks for Codex/OpenAI image generation or approves Codex for the media handoff.".to_string(),
            "Check Codex availability/auth before starting the provider session.".to_string(),
            "From Claude/Grok/other provider tabs, call send_prompt_to_provider with providerId=codex-cli and userApproved=true so ShellX starts Codex in the same local/WSL/SSH environment.".to_string(),
            "Do not run codex exec directly, inspect .codex logs, or bypass ShellX provider sessions unless the user explicitly asks for debugging after a failed handoff.".to_string(),
            "Do not create local placeholder images with PIL, canvas, SVG, screenshots, or code-only rendering and call them GPT Image output; if no OpenAI image-generation surface is available, report HANDOFF_FAILED with that reason.".to_string(),
            "Do not set timeoutMs below 900000 for GPT Image/media handoffs; omit timeoutMs when unsure so ShellX uses its long default.".to_string(),
            "Do not pass gpt-image-2 as the Responses API model field; Responses image generation uses a mainline model with the image_generation tool.".to_string(),
            "If Codex cannot access image generation in the current environment, report that preflight instead of silently switching to Grok Imagine or another image provider.".to_string(),
        ],
        receipt_kinds: vec![
            "media-requested".to_string(),
            "provider-health-checked".to_string(),
            "artifact-created".to_string(),
        ],
        fallback_rule: "Ask the user before using Grok Imagine or any other image provider.".to_string(),
        provenance: CardProvenance {
            source: "codex-routed:gpt-image".to_string(),
            refresh_hint: "Refresh from Codex provider probes and official OpenAI image generation docs before a release when image tooling changes.".to_string(),
        },
    }
}

fn antigravity_nano_banana_image_card() -> ModelInstructionCard {
    ModelInstructionCard {
        id: "antigravity-nano-banana-image".to_string(),
        display_name: "Antigravity Image Generation".to_string(),
        provider_id: "antigravity-cli".to_string(),
        category: "media-generation".to_string(),
        status: "bundled".to_string(),
        route_mode: "explicitOnly".to_string(),
        shellx_may_auto_route: false,
        intent_examples: vec![
            "generate an image with Antigravity".to_string(),
            "use Nano Banana to create this image".to_string(),
            "ask Antigravity to make an image from these source images".to_string(),
        ],
        preflight_checks: vec![
            preflight(
                "antigravityAvailable",
                "Antigravity CLI is available in this environment",
                true,
            ),
            preflight(
                "antigravityAuthenticated",
                "Antigravity is authenticated for the selected provider session",
                true,
            ),
            preflight(
                "antigravityImageToolVisible",
                "The native generate_image tool is visible in the installed Antigravity session",
                true,
            ),
            preflight(
                "mediaInputReady",
                "Prompt and any user-supplied source images are ready",
                true,
            ),
        ],
        capabilities: vec![
            capability(
                "generateImage",
                "Image generation",
                "native",
                "Use the installed Antigravity/Nano Banana generate_image tool. Prompt, ImageName, toolAction, and toolSummary are required by the current native surface.",
            ),
            capability(
                "sourceImageInputs",
                "Source image inputs",
                "native",
                "Pass AspectRatio or ImagePaths only when the user supplied those inputs.",
            ),
        ],
        tool_exposure: antigravity_image_tool_exposure(),
        invocation: CardInvocation {
            surface: "antigravity-native-or-provider-handoff".to_string(),
            debug_api_path: Some("/provider-sessions/start".to_string()),
            command_hint: Some("Antigravity image recipe: in an already-running Antigravity session, call native generate_image directly. From a different ShellX-host-enabled provider/session, call send_prompt_to_provider with providerId=antigravity-cli and userApproved=true; omit targetTabId for the same visible tab, use ShellX's long media timeout, and set includeShellxTooling=false to select the target provider session's existing off/no-ShellX-tooling mode unless the task independently needs ShellX tooling. Request generate_image with an operator-visible ImageName and returned artifact path or receipt. Pass AspectRatio or ImagePaths only when the user supplied them.".to_string()),
            requires_user_visible_selection: true,
        },
        agent_instructions: vec![
            "Use this card only when the user explicitly asks for Antigravity image generation or approves Antigravity for the handoff.".to_string(),
            "In an already-running Antigravity session, use native generate_image directly; do not hand off to Antigravity from Antigravity.".to_string(),
            "From a different ShellX-host-enabled provider/session, call send_prompt_to_provider with providerId=antigravity-cli and userApproved=true. Use the same visible tab by default; omit targetTabId unless the user names another tab.".to_string(),
            "For that cross-provider handoff, preserve ShellX's long media timeout and set includeShellxTooling=false to select the target provider session's existing off/no-ShellX-tooling mode unless the task independently needs ShellX tooling.".to_string(),
            "Request generate_image with an operator-visible ImageName and returned artifact path or receipt.".to_string(),
            "Pass AspectRatio or ImagePaths only when the user supplied them.".to_string(),
            "Do not replace native generate_image with Browser automation, Vision Describe, raw shell commands, or another provider.".to_string(),
            "If Antigravity or generate_image is unavailable, report the failed preflight instead of silently switching providers.".to_string(),
        ],
        receipt_kinds: vec![
            "media-requested".to_string(),
            "provider-health-checked".to_string(),
            "artifact-created".to_string(),
        ],
        fallback_rule: "Ask the user before using GPT Image, Grok Imagine, or another image provider.".to_string(),
        provenance: antigravity_media_provenance(),
    }
}

fn antigravity_video_generation_card() -> ModelInstructionCard {
    ModelInstructionCard {
        id: "antigravity-video-generation".to_string(),
        display_name: "Antigravity Video Generation".to_string(),
        provider_id: "antigravity-cli".to_string(),
        category: "media-generation".to_string(),
        status: "provider-unavailable".to_string(),
        route_mode: "explicitOnly".to_string(),
        shellx_may_auto_route: false,
        intent_examples: vec![
            "generate a video with Antigravity".to_string(),
            "make this prompt into an Antigravity video".to_string(),
            "use Nano Banana to create a video".to_string(),
        ],
        preflight_checks: vec![preflight(
            "antigravityVideoToolVisible",
            "The installed Antigravity CLI exposes a native video-generation tool (currently unavailable)",
            true,
        )],
        capabilities: vec![capability(
            "videoGeneration",
            "Video generation",
            "not-supported",
            "The current native Antigravity CLI has no video-generation tool. Video attachment or analysis and ShellX Browser WebM recording do not satisfy this capability.",
        )],
        tool_exposure: unavailable_media_tool_exposure(),
        invocation: CardInvocation {
            surface: "provider-capability-boundary".to_string(),
            debug_api_path: None,
            command_hint: None,
            requires_user_visible_selection: true,
        },
        agent_instructions: vec![
            "The current native Antigravity CLI has no video-generation tool; do not launch Antigravity solely for this unsupported request.".to_string(),
            "Video attachment or analysis and ShellX Browser WebM recording are not Antigravity video generation.".to_string(),
            "State that the named capability is unavailable, then ask the user before routing to Grok Imagine or another future video provider.".to_string(),
            "When the installed Antigravity version changes, refresh this boundary by re-probing the official tool catalogue and one live no-tool ShellX canary.".to_string(),
        ],
        receipt_kinds: vec![
            "provider-capability-unavailable".to_string(),
            "provider-capability-reviewed".to_string(),
        ],
        fallback_rule: "Ask the user before routing to Grok Imagine or any future video provider.".to_string(),
        provenance: antigravity_media_provenance(),
    }
}

fn codex_cli_card() -> ModelInstructionCard {
    ModelInstructionCard {
        id: "codex-cli".to_string(),
        display_name: "Codex CLI".to_string(),
        provider_id: "codex-cli".to_string(),
        category: "coding-agent".to_string(),
        status: "bundled".to_string(),
        route_mode: "explicitOnly".to_string(),
        shellx_may_auto_route: false,
        intent_examples: vec![
            "ask Codex to audit this change".to_string(),
            "run this task with Codex CLI".to_string(),
            "have Codex review Claude's patch".to_string(),
        ],
        preflight_checks: vec![
            preflight("binaryInstalled", "codex binary is on PATH", true),
            preflight("authReady", "Codex CLI subscription/auth is ready", true),
            preflight("cwdReadable", "Working directory is readable", true),
        ],
        capabilities: vec![
            capability(
                "chatStreaming",
                "Chat streaming",
                "observable",
                "ShellX reads JSONL output from codex exec/resume.",
            ),
            capability(
                "fileWrites",
                "File writes",
                "observable",
                "Codex JSONL can expose file-change items; ShellX also observes the worktree.",
            ),
            capability(
                "terminalCommands",
                "Terminal commands",
                "observable",
                "Codex JSONL exposes command execution items.",
            ),
            capability(
                "mcpToolCalls",
                "MCP tool calls",
                "observable",
                "Codex JSONL can expose MCP tool-call items.",
            ),
            capability(
                "permissionPrompts",
                "Permission prompts",
                "providerFlagsOnly",
                "ShellX maps permission mode to CLI flags; native prompts are not yet ShellX permission-pill events.",
            ),
        ],
        tool_exposure: coding_agent_tool_exposure(),
        invocation: CardInvocation {
            surface: "provider-session".to_string(),
            debug_api_path: Some("/provider-sessions/start".to_string()),
            command_hint: Some("providerId: codex-cli. From another ShellX agent/provider tab, call send_prompt_to_provider with providerId=codex-cli and userApproved=true; omit targetTabId for same-tab handoff.".to_string()),
            requires_user_visible_selection: true,
        },
        agent_instructions: vec![
            "Use only when the user explicitly asks for Codex or approves Codex as a handoff agent.".to_string(),
            "From Claude/Grok/other provider tabs, call send_prompt_to_provider with providerId=codex-cli and userApproved=true to start Codex on the same visible tab and environment.".to_string(),
            "Record why Codex was selected and attach a handoff receipt before starting a long task.".to_string(),
            "If Codex is unavailable, report the failed preflight and ask before using another coding agent.".to_string(),
        ],
        receipt_kinds: vec![
            "handoff-requested".to_string(),
            "provider-health-checked".to_string(),
            "provider-session-started".to_string(),
            "handoff-result".to_string(),
        ],
        fallback_rule: "Ask the user before using Claude Code, Antigravity, or Grok instead.".to_string(),
        provenance: bundled_provenance(),
    }
}

fn claude_code_card() -> ModelInstructionCard {
    ModelInstructionCard {
        id: "claude-code".to_string(),
        display_name: "Claude Code".to_string(),
        provider_id: "claude-code".to_string(),
        category: "coding-agent".to_string(),
        status: "bundled".to_string(),
        route_mode: "explicitOnly".to_string(),
        shellx_may_auto_route: false,
        intent_examples: vec![
            "ask Claude Code to implement this plan".to_string(),
            "have Claude audit Codex's patch".to_string(),
            "run this in Claude Code".to_string(),
        ],
        preflight_checks: vec![
            preflight("binaryInstalled", "claude binary is on PATH", true),
            preflight("authReady", "Claude Code subscription/auth is ready", true),
            preflight("cwdReadable", "Working directory is readable", true),
        ],
        capabilities: vec![
            capability(
                "chatStreaming",
                "Chat streaming",
                "observable",
                "ShellX reads stream-json text deltas and final messages.",
            ),
            capability(
                "fileWrites",
                "File writes",
                "declared",
                "Claude tool-use blocks can describe edits; ShellX should verify on disk.",
            ),
            capability(
                "terminalCommands",
                "Terminal commands",
                "declared",
                "Claude tool-use and hook events can expose command intent; ShellX should verify exit/result evidence.",
            ),
            capability(
                "mcpToolCalls",
                "MCP tool calls",
                "observable",
                "Claude can load an MCP config and stream tool-use blocks.",
            ),
            capability(
                "permissionPrompts",
                "Permission prompts",
                "providerFlagsOnly",
                "ShellX maps permission mode to Claude flags; native prompts are not yet ShellX permission-pill events.",
            ),
        ],
        tool_exposure: coding_agent_tool_exposure(),
        invocation: CardInvocation {
            surface: "provider-session".to_string(),
            debug_api_path: Some("/provider-sessions/start".to_string()),
            command_hint: Some("providerId: claude-code".to_string()),
            requires_user_visible_selection: true,
        },
        agent_instructions: vec![
            "Use only when the user explicitly asks for Claude Code or approves Claude as a handoff agent.".to_string(),
            "For large implementation tasks, pass a compact plan and require verification output back to ShellX.".to_string(),
            "If Claude is unavailable, report the failed preflight and ask before using another coding agent.".to_string(),
        ],
        receipt_kinds: vec![
            "handoff-requested".to_string(),
            "provider-health-checked".to_string(),
            "provider-session-started".to_string(),
            "handoff-result".to_string(),
        ],
        fallback_rule: "Ask the user before using Codex CLI, Antigravity, or Grok instead.".to_string(),
        provenance: bundled_provenance(),
    }
}

fn antigravity_cli_card() -> ModelInstructionCard {
    ModelInstructionCard {
        id: "antigravity-cli".to_string(),
        display_name: "Antigravity CLI".to_string(),
        provider_id: "antigravity-cli".to_string(),
        category: "coding-agent".to_string(),
        status: "bundled".to_string(),
        route_mode: "explicitOnly".to_string(),
        shellx_may_auto_route: false,
        intent_examples: vec![
            "run this with Antigravity".to_string(),
            "ask Antigravity to inspect this repo".to_string(),
            "test the Google agent path".to_string(),
        ],
        preflight_checks: vec![
            preflight("binaryInstalled", "agy binary is on PATH", true),
            preflight("authReady", "Antigravity auth is ready", true),
            preflight("cwdReadable", "Working directory is readable", true),
        ],
        capabilities: vec![
            capability(
                "chatStreaming",
                "Chat streaming",
                "supported",
                "Antigravity 1.1.8+ emits init, step_update, and result NDJSON with text deltas and usage.",
            ),
            capability(
                "fileWrites",
                "File writes",
                "supported",
                "File-changing native tools are normalized from Antigravity tool_info events; verify final Git/filesystem state before completion.",
            ),
            capability(
                "terminalCommands",
                "Terminal commands",
                "supported",
                "Native command tool_info events are normalized into ShellX command activity.",
            ),
            capability(
                "mcpToolCalls",
                "MCP tool calls",
                "unknown",
                "Antigravity discovers workspace MCP schemas, but 1.1.8 through 1.1.11 print-mode call canaries never produced a real MCP tools/call; ShellX host MCP stays disabled.",
            ),
            capability(
                "permissionPrompts",
                "Permission prompts",
                "providerFlagsOnly",
                "ShellX maps permission mode to available CLI flags; native prompts are not yet ShellX permission-pill events.",
            ),
        ],
        tool_exposure: coding_agent_tool_exposure(),
        invocation: CardInvocation {
            surface: "provider-session".to_string(),
            debug_api_path: Some("/provider-sessions/start".to_string()),
            command_hint: Some("providerId: antigravity-cli".to_string()),
            requires_user_visible_selection: true,
        },
        agent_instructions: vec![
            "Use only when the user explicitly asks for Antigravity or approves it as a handoff agent.".to_string(),
            "Prefer Antigravity native file, command, browser, search, image, and subagent tools; return to ShellX for host-scoped Vault, evidence, or cross-provider handoff work.".to_string(),
            "If Antigravity is unavailable, report the failed preflight and ask before using another coding agent.".to_string(),
        ],
        receipt_kinds: vec![
            "handoff-requested".to_string(),
            "provider-health-checked".to_string(),
            "provider-session-started".to_string(),
            "host-verification".to_string(),
            "handoff-result".to_string(),
        ],
        fallback_rule: "Ask the user before using Codex CLI, Claude Code, or Grok instead.".to_string(),
        provenance: bundled_provenance(),
    }
}

fn shellx_preview_doctor_card() -> ModelInstructionCard {
    ModelInstructionCard {
        id: "shellx-preview-doctor".to_string(),
        display_name: "ShellX Preview Doctor".to_string(),
        provider_id: "shellx-host".to_string(),
        category: "shellx-host-tool".to_string(),
        status: "bundled".to_string(),
        route_mode: "explicitOnly".to_string(),
        shellx_may_auto_route: false,
        intent_examples: vec![
            "check why preview is broken".to_string(),
            "diagnose this project preview".to_string(),
            "verify the app through ShellX preview".to_string(),
        ],
        preflight_checks: vec![
            preflight("debugApiHealthy", "ShellX debug API is reachable", true),
            preflight("cwdReadable", "Working directory is readable", true),
            preflight("previewTargetKnown", "Preview target or project root is known", false),
        ],
        capabilities: vec![
            capability(
                "previewDiagnostics",
                "Preview diagnostics",
                "native",
                "ShellX owns preview diagnose/start/log surfaces.",
            ),
            capability(
                "browserSmoke",
                "Browser smoke",
                "hostRequired",
                "Use Playwright or the debug API when a rendered UI check is required.",
            ),
            capability(
                "receipts",
                "Receipts",
                "native",
                "Attach preview diagnosis evidence to build or handoff receipts.",
            ),
        ],
        tool_exposure: shellx_host_tool_exposure(),
        invocation: CardInvocation {
            surface: "debug-api".to_string(),
            debug_api_path: Some("/preview/work/diagnose".to_string()),
            command_hint: Some("Run preview diagnose before asking a model to debug UI symptoms.".to_string()),
            requires_user_visible_selection: false,
        },
        agent_instructions: vec![
            "Use this when the user asks for ShellX preview verification or a model needs local evidence before debugging.".to_string(),
            "Record diagnosis output as host evidence before handing work to another agent.".to_string(),
            "Do not claim a visual result without a preview, screenshot, or browser smoke receipt.".to_string(),
        ],
        receipt_kinds: vec![
            "preview-diagnosed".to_string(),
            "host-verification".to_string(),
            "artifact-previewed".to_string(),
        ],
        fallback_rule: "Ask the user before continuing with available logs only when preview diagnosis cannot run.".to_string(),
        provenance: bundled_provenance(),
    }
}

fn preflight(id: &str, label: &str, required: bool) -> CardPreflightCheck {
    CardPreflightCheck {
        id: id.to_string(),
        label: label.to_string(),
        required,
    }
}

fn capability(id: &str, label: &str, level: &str, notes: &str) -> CardCapability {
    CardCapability {
        id: id.to_string(),
        label: label.to_string(),
        level: level.to_string(),
        notes: notes.to_string(),
    }
}

fn tool_exposure_modes() -> Vec<ToolExposureModeSummary> {
    vec![
        tool_exposure_mode(
            "nativeFirst",
            "Native First",
            "Prefer the selected provider's native terminal, file, MCP, and streaming tools for ordinary work.",
            "Use ShellX host tools only for ShellX-specific context, previews, receipts, assets, or explicit cross-provider handoff.",
        ),
        tool_exposure_mode(
            "hostBridge",
            "Host Bridge",
            "Use a small explicit ShellX bridge for named handoff, media, preview, asset, or receipt actions.",
            "Call only the listed ShellX tools and preserve the selected tab's local/WSL/SSH context.",
        ),
        tool_exposure_mode(
            "hostFull",
            "Host Full",
            "Allow broad ShellX host tooling for diagnostics, verification, and operator-driven repair work.",
            "Use only after the user enables a high-trust host-tools mode for the selected session.",
        ),
        tool_exposure_mode(
            "off",
            "Off",
            "Hide ShellX host tools from the provider beyond minimal session context.",
            "Do not use ShellX handoff or host diagnostics unless the user changes the exposure mode.",
        ),
    ]
}

fn tool_exposure_mode(
    id: &str,
    label: &str,
    description: &str,
    agent_rule: &str,
) -> ToolExposureModeSummary {
    ToolExposureModeSummary {
        id: id.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        agent_rule: agent_rule.to_string(),
    }
}

fn media_handoff_tool_exposure(surface: &str) -> CardToolExposurePolicy {
    card_tool_exposure(
        "hostBridge",
        &format!("Use the named provider's native media surface for {surface}; do not emulate output with local scripts."),
        "Use ShellX only for explicit user-approved handoff, provider health checks, asset import, and receipts.",
        &[
            "model_instruction_cards",
            "provider_adapters",
            "provider_sessions",
            "session_tooling",
            "send_prompt_to_session",
            "send_prompt_to_provider",
            "import_session_asset",
        ],
    )
}

fn antigravity_image_tool_exposure() -> CardToolExposurePolicy {
    card_tool_exposure(
        "nativeFirst",
        "In an already-running Antigravity session, use native generate_image directly; do not emulate image output with local scripts.",
        "Only a different ShellX-host-enabled provider/session may use the explicit user-approved handoff bridge into Antigravity. The target session stays in its requested no-ShellX-tooling mode.",
        &[
            "model_instruction_cards",
            "provider_adapters",
            "provider_sessions",
            "session_tooling",
            "send_prompt_to_provider",
            "import_session_asset",
        ],
    )
}

fn unavailable_media_tool_exposure() -> CardToolExposurePolicy {
    card_tool_exposure(
        "off",
        "Do not invoke Antigravity for an unavailable native media capability.",
        "Do not use a ShellX handoff to launch Antigravity for this unsupported request.",
        &[],
    )
}

fn coding_agent_tool_exposure() -> CardToolExposurePolicy {
    card_tool_exposure(
        "nativeFirst",
        "Use the selected coding agent's native terminal, file, patch, and MCP tools whenever they are available.",
        "Use ShellX for session context, health checks, cross-provider handoff, preview/assets, and receipt evidence.",
        &[
            "get_session_info",
            "session_tooling",
            "model_instruction_cards",
            "provider_adapters",
            "provider_sessions",
            "send_prompt_to_provider",
            "send_prompt_to_session",
        ],
    )
}

fn shellx_host_tool_exposure() -> CardToolExposurePolicy {
    card_tool_exposure(
        "hostBridge",
        "No provider-native substitute exists for ShellX preview/debug receipts; provider tools can inspect project files after ShellX reports evidence.",
        "Use the named ShellX host tool directly, then return compact evidence to the active provider.",
        &[
            "get_session_info",
            "session_tooling",
            "preview_diagnose",
            "preview_start",
            "preview_logs",
        ],
    )
}

fn card_tool_exposure(
    default_mode: &str,
    native_tool_rule: &str,
    shellx_tool_rule: &str,
    allowed_shellx_tools: &[&str],
) -> CardToolExposurePolicy {
    CardToolExposurePolicy {
        default_mode: default_mode.to_string(),
        native_tool_rule: native_tool_rule.to_string(),
        shellx_tool_rule: shellx_tool_rule.to_string(),
        allowed_shellx_tools: allowed_shellx_tools
            .iter()
            .map(|tool| (*tool).to_string())
            .collect(),
    }
}

fn bundled_provenance() -> CardProvenance {
    CardProvenance {
        source: "bundled-shellx-card".to_string(),
        refresh_hint: "Refresh from provider capability probes, official CLI docs, and live session observations before a release when providers change.".to_string(),
    }
}

fn antigravity_media_provenance() -> CardProvenance {
    CardProvenance {
        source: "antigravity-native-tool-canary:2026-08-11".to_string(),
        refresh_hint: "When the installed Antigravity version changes, re-probe the official tool catalogue and one live ShellX canary without ShellX tooling before changing this card.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn cards_have_unique_ids_and_no_auto_routing() {
        let state = model_instruction_cards_state();
        assert!(!state.policy.shellx_may_auto_route);
        assert_eq!(state.policy.default_route_mode, "explicitOnly");
        assert_eq!(state.policy.default_tool_exposure_mode, "nativeFirst");
        assert!(state
            .policy
            .tool_exposure_modes
            .iter()
            .any(|mode| mode.id == "nativeFirst" && mode.label == "Native First"));
        assert!(state
            .policy
            .tool_exposure_modes
            .iter()
            .any(|mode| mode.id == "hostBridge" && mode.label == "Host Bridge"));
        assert!(state
            .policy
            .tool_exposure_modes
            .iter()
            .any(|mode| mode.id == "hostFull" && mode.label == "Host Full"));
        assert!(state
            .policy
            .tool_exposure_modes
            .iter()
            .any(|mode| mode.id == "off" && mode.label == "Off"));

        let mut seen = HashSet::new();
        for card in state.cards {
            assert!(
                seen.insert(card.id.clone()),
                "duplicate card id: {}",
                card.id
            );
            assert_eq!(card.route_mode, "explicitOnly");
            assert!(!card.shellx_may_auto_route);
            assert!(card.fallback_rule.contains("Ask the user"));
            assert!(!card.tool_exposure.native_tool_rule.is_empty());
            assert!(!card.tool_exposure.shellx_tool_rule.is_empty());
        }
    }

    #[test]
    fn grok_imagine_video_requires_grok_health_and_blocks_silent_fallback() {
        let state = model_instruction_cards_state();
        let card = state
            .cards
            .iter()
            .find(|card| card.id == "grok-imagine-video")
            .expect("missing grok-imagine-video card");

        assert_eq!(card.provider_id, "grok");
        assert_eq!(card.category, "media-generation");
        assert!(card
            .preflight_checks
            .iter()
            .any(|check| { check.id == "grokConnected" && check.required }));
        assert!(card
            .preflight_checks
            .iter()
            .any(|check| { check.id == "grokToolsHealthy" && check.required }));
        assert!(card
            .fallback_rule
            .contains("Ask the user before using another video provider"));
        assert!(card
            .agent_instructions
            .iter()
            .any(|line| line.contains("send_prompt_to_session")));
        assert_eq!(card.tool_exposure.default_mode, "hostBridge");
        assert!(card
            .tool_exposure
            .allowed_shellx_tools
            .iter()
            .any(|tool| tool == "send_prompt_to_session"));
    }

    #[test]
    fn codex_gpt_image_card_is_codex_routed() {
        let state = model_instruction_cards_state();
        let card = state
            .cards
            .iter()
            .find(|card| card.id == "codex-gpt-image")
            .expect("missing codex-gpt-image card");

        assert_eq!(card.provider_id, "codex-cli");
        assert_eq!(card.status, "codex-routed");
        assert!(card
            .preflight_checks
            .iter()
            .any(|check| check.id == "codexAvailable" && check.required));
        assert!(card
            .preflight_checks
            .iter()
            .any(|check| check.id == "openAiImageToolReady" && check.required));
        assert!(card
            .invocation
            .command_hint
            .as_deref()
            .is_some_and(|hint| hint.contains("Codex")));
        assert!(card
            .capabilities
            .iter()
            .any(|cap| cap.notes.contains("gpt-image-2")));
        let serialized = serde_json::to_string(card).expect("serialize card");
        assert!(serialized.contains("GPT Image 2"));
        assert!(serialized.contains("gpt-image-2"));
        assert!(serialized.contains("do not put gpt-image-2 in the Responses model field"));
        assert!(serialized.contains("Do not create local placeholder images"));
        assert!(card
            .fallback_rule
            .contains("Ask the user before using Grok Imagine"));
        assert_eq!(card.tool_exposure.default_mode, "hostBridge");
        assert!(card
            .tool_exposure
            .shellx_tool_rule
            .contains("explicit user-approved handoff"));
    }

    #[test]
    fn antigravity_media_cards_keep_image_native_and_video_unavailable() {
        let state = model_instruction_cards_state();
        let image = state
            .cards
            .iter()
            .find(|card| card.id == "antigravity-nano-banana-image")
            .expect("missing antigravity-nano-banana-image card");

        assert_eq!(image.provider_id, "antigravity-cli");
        assert_eq!(image.category, "media-generation");
        assert_eq!(image.status, "bundled");
        assert!(image
            .preflight_checks
            .iter()
            .any(|check| check.id == "antigravityImageToolVisible" && check.required));
        assert!(image
            .capabilities
            .iter()
            .any(|capability| capability.id == "generateImage" && capability.level == "native"));
        assert!(image
            .agent_instructions
            .iter()
            .any(|line| line.contains("generate_image")));
        assert!(
            image
                .agent_instructions
                .iter()
                .any(|line| line.contains("Browser automation")
                    && line.contains("raw shell commands"))
        );
        assert_eq!(image.tool_exposure.default_mode, "nativeFirst");
        assert!(image
            .tool_exposure
            .native_tool_rule
            .contains("already-running Antigravity session"));
        assert!(image
            .agent_instructions
            .iter()
            .any(|line| line.contains("do not hand off to Antigravity from Antigravity")));
        assert!(image
            .tool_exposure
            .allowed_shellx_tools
            .iter()
            .any(|tool| tool == "send_prompt_to_provider"));
        assert!(!image
            .tool_exposure
            .allowed_shellx_tools
            .iter()
            .any(|tool| tool == "send_prompt_to_session"));

        let video = state
            .cards
            .iter()
            .find(|card| card.id == "antigravity-video-generation")
            .expect("missing antigravity-video-generation card");

        assert_eq!(video.provider_id, "antigravity-cli");
        assert_eq!(video.category, "media-generation");
        assert_eq!(video.status, "provider-unavailable");
        assert_eq!(video.tool_exposure.default_mode, "off");
        assert!(video.tool_exposure.allowed_shellx_tools.is_empty());
        assert!(video.invocation.command_hint.is_none());
        assert!(video
            .capabilities
            .iter()
            .any(|capability| capability.id == "videoGeneration"
                && capability.level == "not-supported"));
        assert!(video.agent_instructions.iter().any(|line| {
            line.contains("do not launch Antigravity solely")
                && line.contains("unsupported request")
        }));
        assert!(video
            .agent_instructions
            .iter()
            .any(|line| line.contains("WebM recording")
                && line.contains("not Antigravity video generation")));
    }

    #[test]
    fn coding_agent_cards_expose_permission_and_handoff_receipts() {
        let state = model_instruction_cards_state();
        for id in ["codex-cli", "claude-code", "antigravity-cli"] {
            let card = state
                .cards
                .iter()
                .find(|card| card.id == id)
                .unwrap_or_else(|| panic!("missing {id} card"));
            assert_eq!(card.category, "coding-agent");
            assert!(card
                .receipt_kinds
                .iter()
                .any(|kind| kind == "handoff-requested"));
            assert!(card
                .capabilities
                .iter()
                .any(|cap| cap.id == "permissionPrompts" && cap.level == "providerFlagsOnly"));
            assert_eq!(card.tool_exposure.default_mode, "nativeFirst");
            assert!(card
                .tool_exposure
                .native_tool_rule
                .contains("native terminal"));
            assert_eq!(
                card.invocation.debug_api_path.as_deref(),
                Some("/provider-sessions/start")
            );
        }
    }
}
