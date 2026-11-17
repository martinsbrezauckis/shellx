use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const TASK_INTENT_TTL: Duration = Duration::from_secs(20 * 60);
const TASK_INTENT_PROMPT_MAX_CHARS: usize = 8_192;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TaskIntentAuthority {
    Create,
    CreateAndRun,
}

#[derive(Clone, Copy, Debug)]
struct PendingTaskIntent {
    authority: TaskIntentAuthority,
    expires_at: Instant,
}

#[derive(Default)]
pub(crate) struct TaskIntentRegistry {
    pending: Mutex<HashMap<String, PendingTaskIntent>>,
}

impl TaskIntentRegistry {
    /// Replace the tab's prior authority with the authority expressed by this
    /// exact operator-authored composer turn. An ordinary follow-up therefore
    /// clears stale Task authority instead of extending it.
    pub(crate) fn register_user_prompt(
        &self,
        tab_id: &str,
        prompt: &str,
    ) -> Option<TaskIntentAuthority> {
        self.register_user_prompt_at(tab_id, prompt, Instant::now())
    }

    fn register_user_prompt_at(
        &self,
        tab_id: &str,
        prompt: &str,
        now: Instant,
    ) -> Option<TaskIntentAuthority> {
        let authority = classify_task_intent(prompt);
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        pending.retain(|_, intent| intent.expires_at > now);
        pending.remove(tab_id);
        if let Some(authority) = authority {
            pending.insert(
                tab_id.to_string(),
                PendingTaskIntent {
                    authority,
                    expires_at: now + TASK_INTENT_TTL,
                },
            );
        }
        authority
    }

    /// Consume one current-turn authority. The provider-controlled request can
    /// neither mint nor reuse it, and create-only intent cannot be escalated to
    /// an immediate run.
    pub(crate) fn consume(
        &self,
        tab_id: &str,
        requested: TaskIntentAuthority,
    ) -> Result<(), String> {
        self.consume_at(tab_id, requested, Instant::now())
    }

    fn consume_at(
        &self,
        tab_id: &str,
        requested: TaskIntentAuthority,
        now: Instant,
    ) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(intent) = pending.remove(tab_id) else {
            return Err("Task creation requires an explicit current user request in this ShellX conversation.".to_string());
        };
        if intent.expires_at <= now {
            return Err("The user request that authorized Task creation has expired. Ask the user to request the Task again.".to_string());
        }
        if requested == TaskIntentAuthority::CreateAndRun
            && intent.authority != TaskIntentAuthority::CreateAndRun
        {
            return Err("The current user request authorizes saving the Task, but not running it immediately.".to_string());
        }
        Ok(())
    }
}

fn classify_task_intent(prompt: &str) -> Option<TaskIntentAuthority> {
    let trimmed = prompt.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > TASK_INTENT_PROMPT_MAX_CHARS
        || trimmed.chars().any(|ch| ch == '\0')
    {
        return None;
    }
    let normalized = trimmed
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();

    const NEGATED_OR_EXPLANATORY: [&str; 33] = [
        "do not create a task",
        "don't create a task",
        "dont create a task",
        "do not create this task",
        "don't create this task",
        "dont create this task",
        "never create a task",
        "do not schedule this",
        "don't schedule this",
        "dont schedule this",
        "without creating a task",
        "how do i create a task",
        "how to create a task",
        "how do i schedule a task",
        "how to schedule a task",
        "how should i schedule",
        "show me how to create a task",
        "show me how to schedule a task",
        "explain how to create a task",
        "explain how to schedule a task",
        "explain task creation",
        "what is a scheduled task",
        "what are scheduled tasks",
        "should i create a task",
        "should i schedule this",
        "do i need to create a task",
        "do i need to schedule a task",
        "can i create a task",
        "can i schedule this",
        "what happens if i create a task",
        "draft a task",
        "brainstorm a task",
        "words create a task",
    ];
    if NEGATED_OR_EXPLANATORY
        .iter()
        .any(|marker| normalized.contains(marker))
    {
        return None;
    }

    const DIRECT_TASK_REQUESTS: [&str; 18] = [
        "create a task",
        "create this task",
        "create this as a task",
        "set up a task",
        "setup a task",
        "set this up as a task",
        "save this as a task",
        "turn this into a task",
        "make this a task",
        "add this task",
        "add this to my tasks",
        "schedule a task",
        "schedule this task",
        "schedule this as a task",
        "create a reminder",
        "set a reminder",
        "remind me ",
        "schedule this ",
    ];
    let command = direct_request_command(&normalized);
    if !DIRECT_TASK_REQUESTS.iter().any(|marker| {
        let marker = marker.trim_end();
        let Some(rest) = command.strip_prefix(marker) else {
            return false;
        };
        phrase_boundary(rest) && (!marker.ends_with("task") || task_object_tail(rest))
    }) && !is_direct_task_command(command)
    {
        return None;
    }

    let execution_text = unquoted_intent_text(command);
    if has_negated_immediate_run_request(&execution_text) {
        Some(TaskIntentAuthority::Create)
    } else if has_affirmative_immediate_run_request(&execution_text) {
        Some(TaskIntentAuthority::CreateAndRun)
    } else {
        Some(TaskIntentAuthority::Create)
    }
}

// Examples and quoted task content cannot grant execution authority.
fn unquoted_intent_text(command: &str) -> String {
    let mut output = String::with_capacity(command.len());
    let mut quote = None;
    let mut previous = None::<char>;
    let mut escaped = false;
    let mut chars = command.chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(delimiter) = quote {
            output.push(' ');
            if ch == delimiter && !escaped {
                quote = None;
            }
            escaped = ch == '\\' && !escaped;
        } else {
            let contraction = ch == '\''
                && previous.is_some_and(char::is_alphanumeric)
                && chars.peek().is_some_and(|next| next.is_alphanumeric());
            if matches!(ch, '\'' | '"' | '`') && !contraction {
                quote = Some(ch);
                output.push(' ');
                escaped = false;
            } else {
                output.push(ch);
            }
        }
        previous = Some(ch);
    }
    output
}

fn has_negated_immediate_run_request(command: &str) -> bool {
    const NEGATED_IMMEDIATE_RUN_REQUESTS: [&str; 15] = [
        "do not run now",
        "don't run now",
        "dont run now",
        "do not run it now",
        "don't run it now",
        "dont run it now",
        "do not run immediately",
        "don't run immediately",
        "dont run immediately",
        "do not start now",
        "don't start now",
        "dont start now",
        "do not start it now",
        "don't start it now",
        "dont start it now",
    ];
    NEGATED_IMMEDIATE_RUN_REQUESTS
        .iter()
        .any(|marker| command.contains(marker))
        || command
            .split(|ch: char| ",.;:!?".contains(ch))
            .any(|clause| {
                let words: Vec<_> = clause.split_whitespace().collect();
                words.iter().enumerate().any(|(index, word)| {
                    ["not", "never", "don't", "dont", "without"].contains(word)
                        && words
                            .iter()
                            .skip(index + 1)
                            .take(4)
                            .any(|word| ["run", "start"].contains(word))
                })
            })
}

fn has_affirmative_immediate_run_request(command: &str) -> bool {
    const IMMEDIATE_RUN_CLAUSE_PREFIXES: [&str; 10] = [
        "create and run",
        "create it and run",
        "set up and run",
        "setup and run",
        "then run",
        "run it now",
        "run now",
        "start it now",
        "start now",
        "run immediately",
    ];
    const IMMEDIATE_RUN_CLAUSE_CONNECTORS: [&str; 9] = [
        " and run it now",
        " and run now",
        " and start it now",
        " and start now",
        " and run immediately",
        " then run it now",
        " then run now",
        " then start it now",
        " then run immediately",
    ];
    command
        .split(['.', ',', ';', ':', '!', '?'])
        .map(str::trim)
        .any(|clause| {
            IMMEDIATE_RUN_CLAUSE_PREFIXES
                .iter()
                .any(|marker| clause.starts_with(marker))
                || IMMEDIATE_RUN_CLAUSE_CONNECTORS
                    .iter()
                    .any(|marker| clause.contains(marker))
        })
}

fn phrase_boundary(rest: &str) -> bool {
    rest.is_empty() || rest.starts_with(|ch: char| ch.is_whitespace() || ",.;:!?".contains(ch))
}

fn task_object_tail(rest: &str) -> bool {
    let rest = rest.trim_start();
    if rest.is_empty() || rest.starts_with(|ch: char| ",.;:!?".contains(ch)) {
        return true;
    }
    // A Task object may have a purpose, name or schedule. Software nouns
    // such as "task runner", "task manager" and "task logs" are not Tasks.
    [
        "to", "for", "that", "which", "named", "called", "with", "every", "at", "on", "and", "then",
    ]
    .iter()
    .any(|prefix| rest.strip_prefix(prefix).is_some_and(phrase_boundary))
}

fn is_direct_task_command(normalized: &str) -> bool {
    let command = direct_request_command(normalized);
    let Some(object) = [
        "create ",
        "set up ",
        "setup ",
        "make ",
        "add ",
        "save ",
        "schedule ",
    ]
    .iter()
    .find_map(|verb| command.strip_prefix(verb)) else {
        return false;
    };
    let object = object.strip_prefix("and run ").unwrap_or(object);
    let Some(object) = ["a ", "an ", "this ", "my ", "the "]
        .iter()
        .find_map(|determiner| object.strip_prefix(determiner))
    else {
        return false;
    };
    // Permit names such as "weekly maintenance task", but not a separate
    // object followed by "for/to/... the task runner". Ambiguity grants no
    // durable authority; the operator can use an explicit Task command.
    let mut offset = 0;
    for (index, word) in object.split_whitespace().enumerate() {
        if index > 6
            || ["for", "to", "of", "from", "about", "in", "on", "into", "as"].contains(&word)
            || word.contains(|ch: char| ",.;:!?\"'`".contains(ch)) && !word.starts_with("task")
        {
            return false;
        }
        let start = object[offset..]
            .find(word)
            .map(|found| offset + found)
            .unwrap_or(offset);
        if let Some(rest) = object[start..].strip_prefix("task") {
            return phrase_boundary(rest) && task_object_tail(rest);
        }
        offset = start + word.len();
    }
    false
}

fn direct_request_command(normalized: &str) -> &str {
    const REQUEST_PREFIXES: [&str; 11] = [
        "hey, ",
        "hey ",
        "hello, ",
        "hello ",
        "please ",
        "can you ",
        "could you ",
        "would you ",
        "i want you to ",
        "i would like you to ",
        "i'd like you to ",
    ];
    let mut command = normalized;
    for _ in 0..REQUEST_PREFIXES.len() {
        let Some(stripped) = REQUEST_PREFIXES
            .iter()
            .find_map(|prefix| command.strip_prefix(prefix))
        else {
            break;
        };
        command = stripped;
    }
    command
}
