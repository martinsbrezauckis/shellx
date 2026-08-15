use std::collections::BTreeSet;

use serde_json::{json, Value};
use tauri::Url;

use crate::shellx_browser::{
    lock_or_recover, now_ms, push_receipt, resolve_action_tab_index, BrowserActionRequest,
    BrowserActionResponse, BrowserObservation, BrowserObservationRef, BrowserReceipt,
    ShellxBrowserRegistry,
};
use crate::shellx_browser_tasks::browser_agent_step_summary_for_task;

pub(crate) const BROWSER_PROMPT_GUARD_POLICY_VERSION: &str = "shellx.browser-prompt-guard.v1";
const BROWSER_PROMPT_GUARD_OVERRIDE_TTL_MS: i64 = 5 * 60 * 1_000;
const BROWSER_PROMPT_GUARD_MAX_TOKENS_PER_SOURCE: usize = 2_048;
const BROWSER_PROMPT_GUARD_MAX_SIGNAL_IDS: usize = 12;
const BROWSER_PROMPT_GUARD_MAX_CHANNEL_IDS: usize = 5;

#[derive(Clone, Copy)]
struct PromptSignal {
    id: &'static str,
    confidence: PromptSignalConfidence,
    phrases: &'static [&'static str],
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PromptSignalConfidence {
    Medium,
    High,
}

const PROMPT_SIGNALS: &[PromptSignal] = &[
    PromptSignal {
        id: "instructionOverride",
        confidence: PromptSignalConfidence::High,
        phrases: &[
            "ignore previous instructions",
            "ignore all previous instructions",
            "ignore prior instructions",
            "disregard previous instructions",
            "disregard prior instructions",
        ],
    },
    PromptSignal {
        id: "systemPromptOverride",
        confidence: PromptSignalConfidence::High,
        phrases: &[
            "override system prompt",
            "reveal system prompt",
            "replace system message",
            "developer message says",
        ],
    },
    PromptSignal {
        id: "credentialExfiltration",
        confidence: PromptSignalConfidence::High,
        phrases: &[
            "send credentials",
            "exfiltrate credentials",
            "upload your secrets",
            "reveal your password",
            "send api key",
            "send secret token",
        ],
    },
    PromptSignal {
        id: "concealment",
        confidence: PromptSignalConfidence::High,
        phrases: &[
            "do not tell the user",
            "do not show the user",
            "keep this hidden from the user",
            "without user approval",
        ],
    },
    PromptSignal {
        id: "safetyBypass",
        confidence: PromptSignalConfidence::High,
        phrases: &[
            "disable safety checks",
            "bypass safety checks",
            "skip approval checks",
            "ignore security policy",
        ],
    },
    PromptSignal {
        id: "roleImpersonation",
        confidence: PromptSignalConfidence::Medium,
        phrases: &[
            "you are chatgpt",
            "you are an ai assistant",
            "system message",
        ],
    },
    PromptSignal {
        id: "toolDirective",
        confidence: PromptSignalConfidence::Medium,
        phrases: &[
            "call the tool",
            "use browser tool",
            "execute command",
            "run shell command",
        ],
    },
    PromptSignal {
        id: "secretDirective",
        confidence: PromptSignalConfidence::Medium,
        phrases: &["reveal password", "api key", "secret token"],
    },
];

#[derive(Debug)]
pub(crate) enum BrowserPromptGuardOutcome {
    NotRequired,
    Proceed(BrowserReceipt),
    Blocked(Box<BrowserActionResponse>),
}

#[derive(Clone, Debug)]
struct PromptGuardContext {
    task_id: Option<String>,
    browser_tab_id: Option<String>,
    profile_id: Option<String>,
    current_url: Option<String>,
    origin: Option<String>,
    observation: Option<BrowserObservation>,
}

#[derive(Clone, Debug)]
struct PromptClassification {
    verdict: &'static str,
    confidence: &'static str,
    signal_ids: Vec<String>,
    channel_ids: Vec<String>,
}

impl ShellxBrowserRegistry {
    pub(crate) fn guard_browser_action_against_prompt_injection(
        &self,
        request: &BrowserActionRequest,
        caller_session_id: Option<&str>,
    ) -> Result<BrowserPromptGuardOutcome, String> {
        let action = request.action.trim();
        if !browser_action_requires_prompt_guard(action) {
            return Ok(BrowserPromptGuardOutcome::NotRequired);
        }

        let mut state = lock_or_recover(&self.state);
        let target_tab_idx = resolve_action_tab_index(&state, request)?;
        let context = prompt_guard_context(&state, request, target_tab_idx);
        let action_classification = classify_proposed_action(request, context.observation.as_ref());
        let (inbound_classification, available) = match context.observation.as_ref() {
            Some(observation) if prompt_guard_observation_is_current(observation, &context) => {
                (classify_inbound_observation(observation), true)
            }
            Some(_) => (
                PromptClassification {
                    verdict: "unavailable",
                    confidence: "none",
                    signal_ids: Vec::new(),
                    channel_ids: Vec::new(),
                },
                false,
            ),
            None if prompt_guard_requires_existing_page(&context) => (
                PromptClassification {
                    verdict: "unavailable",
                    confidence: "none",
                    signal_ids: Vec::new(),
                    channel_ids: Vec::new(),
                },
                false,
            ),
            None => (
                PromptClassification {
                    verdict: "allow",
                    confidence: "none",
                    signal_ids: Vec::new(),
                    channel_ids: Vec::new(),
                },
                true,
            ),
        };
        let overall_verdict = if !available {
            "unavailable"
        } else if inbound_classification.verdict == "block"
            || action_classification.verdict == "block"
        {
            "block"
        } else if inbound_classification.verdict == "warn"
            || action_classification.verdict == "warn"
        {
            "warn"
        } else {
            "allow"
        };
        let confidence = strongest_confidence(
            inbound_classification.confidence,
            action_classification.confidence,
        );
        let signal_ids = merged_bounded_values(
            &inbound_classification.signal_ids,
            &action_classification.signal_ids,
            BROWSER_PROMPT_GUARD_MAX_SIGNAL_IDS,
        );
        let channel_ids = merged_bounded_values(
            &inbound_classification.channel_ids,
            &action_classification.channel_ids,
            BROWSER_PROMPT_GUARD_MAX_CHANNEL_IDS,
        );
        let observation_snapshot_id = context
            .observation
            .as_ref()
            .filter(|observation| prompt_guard_observation_is_current(observation, &context))
            .map(|observation| observation.snapshot_id.clone());

        if matches!(overall_verdict, "block" | "unavailable")
            && prompt_guard_operator_override_is_valid(
                &state,
                request,
                caller_session_id,
                &context,
                observation_snapshot_id.as_deref(),
            )
        {
            let override_of_receipt_id = request.approval_id.clone();
            let receipt = push_receipt(
                &mut state,
                "browserPromptInjectionOverrideApplied",
                context.task_id.clone(),
                context.profile_id.clone(),
                "Operator applied a one-request Browser prompt-injection override".to_string(),
                prompt_guard_evidence(
                    action,
                    &context,
                    observation_snapshot_id.as_deref(),
                    "override",
                    &inbound_classification,
                    &action_classification,
                    confidence,
                    &signal_ids,
                    &channel_ids,
                    true,
                    override_of_receipt_id.as_deref(),
                ),
            );
            return Ok(BrowserPromptGuardOutcome::Proceed(receipt));
        }

        let receipt_kind = match overall_verdict {
            "block" | "unavailable" => "browserPromptInjectionBlocked",
            "warn" => "browserPromptInjectionWarning",
            _ => "browserPromptInjectionAllowed",
        };
        let receipt = push_receipt(
            &mut state,
            receipt_kind,
            context.task_id.clone(),
            context.profile_id.clone(),
            prompt_guard_summary(overall_verdict).to_string(),
            prompt_guard_evidence(
                action,
                &context,
                observation_snapshot_id.as_deref(),
                overall_verdict,
                &inbound_classification,
                &action_classification,
                confidence,
                &signal_ids,
                &channel_ids,
                false,
                None,
            ),
        );
        if !matches!(overall_verdict, "block" | "unavailable") {
            return Ok(BrowserPromptGuardOutcome::Proceed(receipt));
        }

        let task = context
            .task_id
            .as_deref()
            .and_then(|task_id| state.tasks.iter().find(|task| task.task_id == task_id))
            .cloned();
        let step_summary = task.as_ref().map(|task| {
            browser_agent_step_summary_for_task(
                &state,
                task,
                action,
                "blocked",
                false,
                Some("promptInjectionReview"),
                context.observation.as_ref(),
                None,
                None,
            )
        });
        Ok(BrowserPromptGuardOutcome::Blocked(Box::new(
            BrowserActionResponse {
                ok: false,
                status: "blocked".to_string(),
                task_id: context.task_id,
                current_url: context.current_url,
                required_approval: Some("promptInjectionReview".to_string()),
                requires_engine: false,
                message: Some(if overall_verdict == "unavailable" {
                    "Browser action paused until the current page is observed and classified"
                        .to_string()
                } else {
                    "Browser action blocked by the prompt-injection guard".to_string()
                }),
                observation: None,
                extracted_text: None,
                actionability: None,
                verification: None,
                screenshot: None,
                find_result: None,
                security_state: None,
                step_summary,
                receipt,
            },
        )))
    }
}

fn browser_action_requires_prompt_guard(action: &str) -> bool {
    !matches!(
        action,
        "" | "observe"
            | "extractText"
            | "extractMarkdown"
            | "extractTable"
            | "waitFor"
            | "verify"
            | "findText"
            | "captureScreenshot"
            | "scroll"
            | "goBack"
            | "goForward"
            | "reload"
    )
}

fn prompt_guard_context(
    state: &crate::shellx_browser::BrowserState,
    request: &BrowserActionRequest,
    target_tab_idx: Option<usize>,
) -> PromptGuardContext {
    let task_id = request
        .task_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| target_tab_idx.and_then(|idx| state.tabs[idx].task_id.clone()))
        .or_else(|| state.active_task_id.clone());
    let browser_tab_id = target_tab_idx
        .map(|idx| state.tabs[idx].browser_tab_id.clone())
        .or_else(|| {
            task_id.as_deref().and_then(|task_id| {
                state
                    .tabs
                    .iter()
                    .find(|tab| tab.task_id.as_deref() == Some(task_id))
                    .map(|tab| tab.browser_tab_id.clone())
            })
        });
    let task = task_id
        .as_deref()
        .and_then(|task_id| state.tasks.iter().find(|task| task.task_id == task_id));
    let tab = browser_tab_id
        .as_deref()
        .and_then(|tab_id| state.tabs.iter().find(|tab| tab.browser_tab_id == tab_id));
    let current_url = tab
        .and_then(|tab| tab.url.clone())
        .or_else(|| task.and_then(|task| task.current_url.clone()));
    let observation = task
        .and_then(|task| task.last_observation.clone())
        .or_else(|| {
            browser_tab_id
                .as_deref()
                .and_then(|tab_id| state.tab_observations.get(tab_id).cloned())
        });
    PromptGuardContext {
        task_id,
        browser_tab_id,
        profile_id: tab
            .map(|tab| tab.profile_id.clone())
            .or_else(|| task.map(|task| task.profile_id.clone())),
        origin: current_url.as_deref().and_then(prompt_guard_origin),
        current_url,
        observation,
    }
}

fn prompt_guard_requires_existing_page(context: &PromptGuardContext) -> bool {
    context.current_url.as_deref().is_some_and(|url| {
        let value = url.trim();
        !value.is_empty() && !matches!(value, "about:blank" | "about:newtab")
    })
}

fn prompt_guard_observation_is_current(
    observation: &BrowserObservation,
    context: &PromptGuardContext,
) -> bool {
    !observation.requires_engine
        && !observation.snapshot_id.trim().is_empty()
        && match (observation.url.as_deref(), context.current_url.as_deref()) {
            (Some(observed), Some(current)) => {
                prompt_guard_origin_and_path(observed) == prompt_guard_origin_and_path(current)
            }
            (None, None) => true,
            _ => false,
        }
}

fn prompt_guard_origin(value: &str) -> Option<String> {
    let parsed = Url::parse(value.trim()).ok()?;
    matches!(parsed.scheme(), "http" | "https").then(|| parsed.origin().ascii_serialization())
}

fn prompt_guard_origin_and_path(value: &str) -> Option<String> {
    let parsed = Url::parse(value.trim()).ok()?;
    matches!(parsed.scheme(), "http" | "https")
        .then(|| format!("{}{}", parsed.origin().ascii_serialization(), parsed.path()))
}

fn classify_inbound_observation(observation: &BrowserObservation) -> PromptClassification {
    let mut signals = BTreeSet::new();
    let mut channels = BTreeSet::new();
    collect_signals(
        "visibleText",
        [&observation.title, &observation.text, &observation.markdown],
        &mut signals,
        &mut channels,
    );
    for reference in observation
        .refs
        .iter()
        .filter(|reference| reference.visible == Some(false))
    {
        collect_ref_signals("hiddenContent", reference, &mut signals, &mut channels);
    }
    for reference in &observation.refs {
        collect_signals(
            "domAttribute",
            reference
                .test_id
                .iter()
                .chain(reference.selector.iter())
                .chain(reference.action.iter())
                .chain(reference.option_values.iter()),
            &mut signals,
            &mut channels,
        );
    }
    for field in &observation.form_fields {
        collect_signals(
            "domAttribute",
            std::iter::once(&field.label)
                .chain(field.form_action.iter())
                .chain(field.autocomplete.iter()),
            &mut signals,
            &mut channels,
        );
    }
    for node in &observation.accessibility_tree {
        collect_signals(
            "accessibility",
            std::iter::once(&node.label).chain(node.action.iter()),
            &mut signals,
            &mut channels,
        );
    }
    classification_from_sets(signals, channels, false)
}

fn classify_proposed_action(
    request: &BrowserActionRequest,
    observation: Option<&BrowserObservation>,
) -> PromptClassification {
    let mut signals = BTreeSet::new();
    let mut channels = BTreeSet::new();
    if let Some(reference) =
        observation.and_then(|observation| observed_action_target(request, observation))
    {
        collect_ref_signals("toolResult", reference, &mut signals, &mut channels);
    }
    classification_from_sets(
        signals,
        channels,
        browser_action_has_sensitive_effect(request.action.trim()),
    )
}

fn observed_action_target<'a>(
    request: &BrowserActionRequest,
    observation: &'a BrowserObservation,
) -> Option<&'a BrowserObservationRef> {
    if let Some(ref_id) = request
        .ref_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(reference) = observation
            .refs
            .iter()
            .find(|reference| reference.ref_id == ref_id)
        {
            return Some(reference);
        }
    }
    request
        .selector
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|selector| {
            observation.refs.iter().find(|reference| {
                reference.selector.as_deref() == Some(selector)
                    || reference.raw_selector.as_deref() == Some(selector)
            })
        })
}

fn collect_ref_signals(
    channel: &str,
    reference: &BrowserObservationRef,
    signals: &mut BTreeSet<String>,
    channels: &mut BTreeSet<String>,
) {
    collect_signals(
        channel,
        std::iter::once(&reference.label)
            .chain(reference.name.iter())
            .chain(reference.action.iter()),
        signals,
        channels,
    );
}

fn collect_signals<'a, I>(
    channel: &str,
    sources: I,
    signals: &mut BTreeSet<String>,
    channels: &mut BTreeSet<String>,
) where
    I: IntoIterator<Item = &'a String>,
{
    let mut matched = false;
    for source in sources {
        let normalized = prompt_guard_classifier_text(source);
        for signal in PROMPT_SIGNALS {
            if signal
                .phrases
                .iter()
                .any(|phrase| normalized.contains(&format!(" {} ", phrase)))
            {
                signals.insert(signal.id.to_string());
                matched = true;
            }
        }
    }
    if matched {
        channels.insert(channel.to_string());
    }
}

fn prompt_guard_classifier_text(value: &str) -> String {
    let mut tokens = Vec::new();
    let mut source_tokens_seen = 0usize;
    for token in value
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
    {
        source_tokens_seen = source_tokens_seen.saturating_add(1);
        if source_tokens_seen > BROWSER_PROMPT_GUARD_MAX_TOKENS_PER_SOURCE {
            break;
        }
        let token = token.to_ascii_lowercase();
        if prompt_guard_token_may_be_secret(&token) || !prompt_guard_vocabulary_contains(&token) {
            if tokens.last().is_some_and(|last| last != "|") {
                tokens.push("|".to_string());
            }
            continue;
        }
        tokens.push(token);
    }
    format!(" {} ", tokens.join(" "))
}

fn prompt_guard_vocabulary_contains(token: &str) -> bool {
    PROMPT_SIGNALS.iter().any(|signal| {
        signal
            .phrases
            .iter()
            .any(|phrase| phrase.split_ascii_whitespace().any(|word| word == token))
    })
}

fn prompt_guard_token_may_be_secret(token: &str) -> bool {
    token.len() > 48
        || (token.len() >= 16
            && token.bytes().any(|byte| byte.is_ascii_alphabetic())
            && token.bytes().any(|byte| byte.is_ascii_digit()))
        || (token.len() >= 6 && token.bytes().all(|byte| byte.is_ascii_digit()))
        || matches!(token, "shellxprotected" | "shellxredacted")
}

fn classification_from_sets(
    signals: BTreeSet<String>,
    channels: BTreeSet<String>,
    sensitive_effect: bool,
) -> PromptClassification {
    let high = signals.iter().any(|id| {
        PROMPT_SIGNALS
            .iter()
            .any(|signal| signal.id == id && signal.confidence == PromptSignalConfidence::High)
    });
    let medium_count = signals
        .iter()
        .filter(|id| {
            PROMPT_SIGNALS.iter().any(|signal| {
                signal.id == id.as_str() && signal.confidence == PromptSignalConfidence::Medium
            })
        })
        .count();
    let (verdict, confidence) = if high || medium_count >= 2 {
        ("block", "high")
    } else if medium_count == 1 || sensitive_effect {
        ("warn", "medium")
    } else {
        ("allow", "none")
    };
    PromptClassification {
        verdict,
        confidence,
        signal_ids: signals
            .into_iter()
            .take(BROWSER_PROMPT_GUARD_MAX_SIGNAL_IDS)
            .collect(),
        channel_ids: channels
            .into_iter()
            .take(BROWSER_PROMPT_GUARD_MAX_CHANNEL_IDS)
            .collect(),
    }
}

fn browser_action_has_sensitive_effect(action: &str) -> bool {
    matches!(
        action,
        "capturePageSecretToVault"
            | "fillFromVaultGrant"
            | "fillProfileCardGrant"
            | "readEmailCodeGrant"
            | "useAgentWalletGrant"
            | "uploadFile"
            | "downloadFile"
            | "submitFinal"
            | "delete"
            | "clearSiteData"
            | "cdpCommand"
    )
}

fn strongest_confidence(left: &str, right: &str) -> &'static str {
    if left == "high" || right == "high" {
        "high"
    } else if left == "medium" || right == "medium" {
        "medium"
    } else {
        "none"
    }
}

fn merged_bounded_values(left: &[String], right: &[String], limit: usize) -> Vec<String> {
    left.iter()
        .chain(right.iter())
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(limit)
        .collect()
}

fn prompt_guard_summary(verdict: &str) -> &'static str {
    match verdict {
        "block" => "Browser prompt-injection guard blocked an action",
        "unavailable" => "Browser prompt-injection guard paused an unclassified action",
        "warn" => "Browser prompt-injection guard allowed an action with a warning",
        _ => "Browser prompt-injection guard allowed an action",
    }
}

#[allow(clippy::too_many_arguments)]
fn prompt_guard_evidence(
    action: &str,
    context: &PromptGuardContext,
    observation_snapshot_id: Option<&str>,
    verdict: &str,
    inbound: &PromptClassification,
    proposed_action: &PromptClassification,
    confidence: &str,
    signal_ids: &[String],
    channel_ids: &[String],
    operator_override: bool,
    override_of_receipt_id: Option<&str>,
) -> Value {
    json!({
        "policyVersion": BROWSER_PROMPT_GUARD_POLICY_VERSION,
        "verdict": verdict,
        "confidence": confidence,
        "inboundContentVerdict": inbound.verdict,
        "proposedActionVerdict": proposed_action.verdict,
        "signalIds": signal_ids,
        "channelIds": channel_ids,
        "classificationSource": "fixedVocabularyProjection",
        "action": action,
        "taskId": context.task_id,
        "browserTabId": context.browser_tab_id,
        "origin": context.origin,
        "observationSnapshotId": observation_snapshot_id,
        "operatorOverride": operator_override,
        "overrideOfReceiptId": override_of_receipt_id,
        "overrideExpiresAtMs": operator_override.then(|| now_ms() + BROWSER_PROMPT_GUARD_OVERRIDE_TTL_MS),
        "rawPageContentRetained": false,
        "rawActionArgumentsRetained": false,
    })
}

fn prompt_guard_operator_override_is_valid(
    state: &crate::shellx_browser::BrowserState,
    request: &BrowserActionRequest,
    caller_session_id: Option<&str>,
    context: &PromptGuardContext,
    observation_snapshot_id: Option<&str>,
) -> bool {
    if caller_session_id.is_some() || !request.force {
        return false;
    }
    let Some(approval_id) = request
        .approval_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    if state.receipts.iter().any(|receipt| {
        receipt.kind == "browserPromptInjectionOverrideApplied"
            && receipt
                .evidence
                .get("overrideOfReceiptId")
                .and_then(Value::as_str)
                == Some(approval_id)
    }) {
        return false;
    }
    let Some(blocked) = state.receipts.iter().rev().find(|receipt| {
        receipt.receipt_id == approval_id && receipt.kind == "browserPromptInjectionBlocked"
    }) else {
        return false;
    };
    let current_time_ms = now_ms();
    current_time_ms >= blocked.t
        && current_time_ms.saturating_sub(blocked.t) <= BROWSER_PROMPT_GUARD_OVERRIDE_TTL_MS
        && blocked.task_id == context.task_id
        && evidence_str(blocked, "browserTabId") == context.browser_tab_id.as_deref()
        && evidence_str(blocked, "origin") == context.origin.as_deref()
        && evidence_str(blocked, "action") == Some(request.action.trim())
        && evidence_str(blocked, "observationSnapshotId") == observation_snapshot_id
}

fn evidence_str<'a>(receipt: &'a BrowserReceipt, key: &str) -> Option<&'a str> {
    receipt.evidence.get(key).and_then(Value::as_str)
}

#[cfg(test)]
#[path = "shellx_browser_prompt_guard_tests.rs"]
mod tests;
