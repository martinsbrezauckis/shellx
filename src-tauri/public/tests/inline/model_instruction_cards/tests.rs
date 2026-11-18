use super::*;
use std::collections::HashSet;

#[test]
fn cards_have_unique_ids_and_no_auto_routing() {
    let state = model_instruction_cards_state();
    assert_eq!(state.version, MODEL_INSTRUCTION_CARDS_VERSION);
    assert_eq!(state.last_reviewed, MODEL_INSTRUCTION_CARDS_REVIEWED_ON);
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
        assert_eq!(card.provenance.review_scope, MODEL_CARD_REVIEW_SCOPE);
        assert_eq!(
            card.provenance.availability_authority,
            MODEL_CARD_AVAILABILITY_AUTHORITY
        );
        assert_eq!(
            card.provenance.native_capability_evidence,
            MODEL_CARD_NATIVE_CAPABILITY_EVIDENCE
        );
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
    assert!(image
        .agent_instructions
        .iter()
        .any(|line| line.contains("Browser automation") && line.contains("raw shell commands")));
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
    assert!(video.capabilities.iter().any(
        |capability| capability.id == "videoGeneration" && capability.level == "not-supported"
    ));
    assert!(video.agent_instructions.iter().any(|line| {
        line.contains("do not launch Antigravity solely") && line.contains("unsupported request")
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
