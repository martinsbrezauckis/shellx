//! Pure, bounded scheduling rules for ShellX Tasks.
//!
//! Store, lease, provider execution, UI, and application wiring intentionally
//! remain outside this module. A future coordinator supplies its persisted
//! watermark and known occurrence IDs, then atomically stores the plan it
//! receives here before starting any work.

use crate::task_model::deterministic_occurrence_id;
pub use crate::task_model::{TaskMissedRunPolicy as MissedRunPolicy, TaskTrigger, TaskWeekday};
use crate::task_time::{
    parse_iana_timezone, resolve_wall_time, validate_local_time, ScheduleError, TaskLocalTime,
};
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc, Weekday};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::collections::BTreeSet;
use std::collections::HashSet;

/// A schedule count is deliberately capped because this is an in-process,
/// foreground scheduler. Long-lived unbounded recurring schedules use an end
/// time instead; a store should rotate an explicit count policy if needed.
pub const MAX_SCHEDULE_OCCURRENCE_COUNT: u32 = 10_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    /// Canonical IANA name, for example `America/New_York`.
    pub timezone: String,
    /// The immutable revision's activation instant. Recurrences never precede it.
    pub starts_at: DateTime<Utc>,
    pub trigger: TaskTrigger,
    #[serde(default)]
    pub bounds: ScheduleBounds,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleBounds {
    /// Inclusive final scheduled instant, if configured.
    pub ends_at: Option<DateTime<Utc>>,
    /// Number of occurrences beginning at zero; cannot exceed the engine cap.
    pub max_occurrences: Option<u32>,
}

/// Stable inputs from the future durable task store. The schedule engine never
/// invents task or revision identifiers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OccurrenceIdentityScope {
    pub task_id: String,
    pub revision_id: String,
}

#[cfg(test)]
#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduledOccurrence {
    pub scheduled_for: DateTime<Utc>,
    pub occurrence_id: String,
}

#[cfg(test)]
#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DuePlan {
    /// Ordered oldest-to-newest, ready for a store to claim atomically.
    pub occurrences: Vec<ScheduledOccurrence>,
    /// Persist this bounded, data-only record with the store's append-only
    /// receipt. It explains selection and suppression decisions without task
    /// instructions, provider output, secrets, or local paths.
    pub receipt: ScheduleDecisionReceipt,
    /// The caller may persist this only after it records the plan or skips it.
    pub evaluated_through: DateTime<Utc>,
}

/// A serializable scheduling decision for the durable receipt journal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleDecisionReceipt {
    pub schema_version: String,
    pub task_id: String,
    pub revision_id: String,
    pub timezone: String,
    pub evaluated_after: DateTime<Utc>,
    pub evaluated_through: DateTime<Utc>,
    pub missed_run_policy: MissedRunPolicy,
    pub decisions: Vec<ScheduleDecision>,
}

impl ScheduleDecisionReceipt {
    fn new(
        schedule: &Schedule,
        scope: &OccurrenceIdentityScope,
        after: DateTime<Utc>,
        now: DateTime<Utc>,
        missed_run_policy: MissedRunPolicy,
    ) -> Self {
        Self {
            schema_version: "shellx.task-schedule-decision.v1".to_string(),
            task_id: scope.task_id.clone(),
            revision_id: scope.revision_id.clone(),
            timezone: schedule.timezone.clone(),
            evaluated_after: after,
            evaluated_through: now,
            missed_run_policy,
            decisions: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ScheduleDecision {
    /// There was no positive-width time window to evaluate.
    EmptyWindow,
    /// A current occurrence was observed inside the due runner's explicit,
    /// fixed grace window. This is ordinary on-time work, not a missed run.
    OnTimeGraceSelected { scheduled_for: DateTime<Utc> },
    /// The caller explicitly elected to skip all missed work in the window.
    MissedWindowSkipped,
    /// A candidate is safe for the occurrence store to claim atomically.
    OccurrencePlanned {
        occurrence_id: String,
        scheduled_for: DateTime<Utc>,
    },
    /// A durable occurrence already exists, so this engine did not return it.
    KnownOccurrenceSuppressed {
        occurrence_id: String,
        scheduled_for: DateTime<Utc>,
    },
    /// A prior scheduling transaction persisted this pending occurrence, but no
    /// executor lease was ever recorded. It is safe to expose the same
    /// deterministic identity again after restart; this never creates a retry.
    KnownPendingOccurrenceReexposed {
        occurrence_id: String,
        scheduled_for: DateTime<Utc>,
    },
    /// `runOnceWhenAvailable` intentionally selects at most one missed run.
    RunOnceWhenAvailableSelected {
        selected_scheduled_for: Option<DateTime<Utc>>,
    },
    /// The definition requires an explicit operator decision before a missed
    /// occurrence is started. The scheduler deliberately returns no work.
    NeedsAttentionRequired,
    /// The foreground runner observed its visible global active-run limit. It
    /// leaves the watermark unchanged so the same occurrence is reconsidered
    /// after capacity is available.
    ConcurrencyDeferred { active_runs: u8, limit: u8 },
    /// An injected clock was earlier than the durable watermark. The runner
    /// does not guess; it leaves the watermark unchanged.
    ClockRollbackDeferred { observed_now: DateTime<Utc> },
}

impl Schedule {
    pub fn validate(&self) -> Result<(), ScheduleError> {
        parse_iana_timezone(&self.timezone)?;
        if let Some(ends_at) = self.bounds.ends_at {
            if ends_at < self.starts_at {
                return Err(ScheduleError::invalid("ends_at is before starts_at"));
            }
        }
        if let Some(max_occurrences) = self.bounds.max_occurrences {
            if max_occurrences == 0 {
                return Err(ScheduleError::invalid("max_occurrences must be positive"));
            }
            if max_occurrences > MAX_SCHEDULE_OCCURRENCE_COUNT {
                return Err(ScheduleError::invalid(format!(
                    "max_occurrences exceeds {MAX_SCHEDULE_OCCURRENCE_COUNT}"
                )));
            }
        }

        match &self.trigger {
            TaskTrigger::Manual => {}
            TaskTrigger::Once { at_ms } => {
                if *at_ms <= 0 {
                    return Err(ScheduleError::invalid("once trigger atMs must be positive"));
                }
                let at = instant_from_millis(*at_ms)?;
                if at < self.starts_at {
                    return Err(ScheduleError::invalid("once trigger is before starts_at"));
                }
            }
            TaskTrigger::Daily { at } | TaskTrigger::Weekdays { at } => {
                validate_local_time(*at)?;
            }
            TaskTrigger::Weekly { weekdays, at } => {
                validate_local_time(*at)?;
                if weekdays.is_empty() {
                    return Err(ScheduleError::invalid(
                        "weekly trigger needs at least one weekday",
                    ));
                }
                let mut seen = HashSet::with_capacity(weekdays.len());
                if weekdays.iter().any(|weekday| !seen.insert(*weekday)) {
                    return Err(ScheduleError::invalid(
                        "weekly trigger contains duplicate weekdays",
                    ));
                }
            }
            TaskTrigger::Monthly { day, at } => {
                validate_local_time(*at)?;
                if !(1..=31).contains(day) {
                    return Err(ScheduleError::invalid("monthly day must be in 1..=31"));
                }
            }
        }
        Ok(())
    }

    fn timezone(&self) -> Result<Tz, ScheduleError> {
        parse_iana_timezone(&self.timezone)
    }
}

impl OccurrenceIdentityScope {
    pub fn validate(&self) -> Result<(), ScheduleError> {
        if self.task_id.is_empty() || self.revision_id.is_empty() {
            return Err(ScheduleError::invalid(
                "occurrence identity needs non-empty task_id and revision_id",
            ));
        }
        Ok(())
    }
}

/// The canonical store-owned occurrence identity over the task, immutable
/// revision, and scheduled millisecond instant.
pub fn occurrence_id(
    scope: &OccurrenceIdentityScope,
    scheduled_for: DateTime<Utc>,
) -> Result<String, ScheduleError> {
    scope.validate()?;
    deterministic_occurrence_id(
        &scope.task_id,
        &scope.revision_id,
        scheduled_for.timestamp_millis(),
    )
    .map_err(ScheduleError::invalid)
}

/// Return the first valid scheduled instant strictly later than `after`.
/// `Manual` schedules intentionally return `None`; Run now is an explicit
/// store/executor operation, not a synthetic clock occurrence.
pub fn next_scheduled_at(
    schedule: &Schedule,
    after: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, ScheduleError> {
    schedule.validate()?;
    let timezone = schedule.timezone()?;
    let candidate = next_raw(schedule, timezone, Some(after))?;
    match candidate {
        Some(candidate) if within_bounds(schedule, timezone, candidate)? => Ok(Some(candidate)),
        _ => Ok(None),
    }
}

/// Return the latest valid scheduled instant at or before `at`.
///
/// The foreground due runner uses this to tell an ordinary near-on-time poll
/// from a genuinely missed window. It deliberately does not read a clock or
/// mutate durable state.
pub(crate) fn latest_scheduled_at(
    schedule: &Schedule,
    at: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, ScheduleError> {
    schedule.validate()?;
    previous_scheduled_at(schedule, schedule.timezone()?, at)
}

/// Build a bounded, data-only receipt for a store-owned scheduling decision.
///
/// Store code owns persistence and may append its own runner classification,
/// but all trigger/timezone/policy fields remain the canonical schedule ones.
pub(crate) fn schedule_decision_receipt(
    schedule: &Schedule,
    scope: &OccurrenceIdentityScope,
    after: DateTime<Utc>,
    through: DateTime<Utc>,
    missed_run_policy: MissedRunPolicy,
    decisions: Vec<ScheduleDecision>,
) -> Result<ScheduleDecisionReceipt, ScheduleError> {
    schedule.validate()?;
    scope.validate()?;
    if decisions.len() > 4 {
        return Err(ScheduleError::invalid(
            "schedule decision receipt exceeds its bounded decision count",
        ));
    }
    let mut receipt =
        ScheduleDecisionReceipt::new(schedule, scope, after, through, missed_run_policy);
    receipt.decisions = decisions;
    Ok(receipt)
}

/// Plan occurrences in the `(after, now]` window without touching a clock or
/// store. `known_occurrence_ids` is supplied by the durable occurrence store;
/// it prevents a crash-recovery caller from asking to start an already claimed
/// occurrence a second time.
#[cfg(test)]
#[allow(dead_code)]
pub fn plan_due_occurrences(
    schedule: &Schedule,
    scope: &OccurrenceIdentityScope,
    after: DateTime<Utc>,
    now: DateTime<Utc>,
    policy: MissedRunPolicy,
    known_occurrence_ids: &BTreeSet<String>,
) -> Result<DuePlan, ScheduleError> {
    schedule.validate()?;
    scope.validate()?;
    if now <= after {
        let mut receipt = ScheduleDecisionReceipt::new(schedule, scope, after, now, policy);
        receipt.decisions.push(ScheduleDecision::EmptyWindow);
        return Ok(DuePlan {
            occurrences: Vec::new(),
            receipt,
            evaluated_through: now,
        });
    }
    if matches!(policy, MissedRunPolicy::Skip) {
        let mut receipt = ScheduleDecisionReceipt::new(schedule, scope, after, now, policy);
        receipt
            .decisions
            .push(ScheduleDecision::MissedWindowSkipped);
        return Ok(DuePlan {
            occurrences: Vec::new(),
            receipt,
            evaluated_through: now,
        });
    }

    if matches!(policy, MissedRunPolicy::NeedsAttention) {
        let mut receipt = ScheduleDecisionReceipt::new(schedule, scope, after, now, policy);
        receipt
            .decisions
            .push(ScheduleDecision::NeedsAttentionRequired);
        return Ok(DuePlan {
            occurrences: Vec::new(),
            receipt,
            evaluated_through: now,
        });
    }

    let timezone = schedule.timezone()?;
    match policy {
        MissedRunPolicy::Skip => unreachable!("handled above"),
        MissedRunPolicy::NeedsAttention => unreachable!("handled above"),
        MissedRunPolicy::RunOnceWhenAvailable => {
            let mut receipt = ScheduleDecisionReceipt::new(schedule, scope, after, now, policy);
            let selected_scheduled_for = previous_scheduled_at(schedule, timezone, now)?
                .filter(|scheduled_for| *scheduled_for > after);
            let occurrences = match selected_scheduled_for.as_ref() {
                Some(scheduled_for) => {
                    let candidate = scheduled_occurrence(scope, *scheduled_for)?;
                    if known_occurrence_ids.contains(&candidate.occurrence_id) {
                        receipt
                            .decisions
                            .push(ScheduleDecision::KnownOccurrenceSuppressed {
                                occurrence_id: candidate.occurrence_id,
                                scheduled_for: *scheduled_for,
                            });
                        Vec::new()
                    } else {
                        receipt.decisions.push(ScheduleDecision::OccurrencePlanned {
                            occurrence_id: candidate.occurrence_id.clone(),
                            scheduled_for: *scheduled_for,
                        });
                        vec![candidate]
                    }
                }
                _ => Vec::new(),
            };
            receipt
                .decisions
                .push(ScheduleDecision::RunOnceWhenAvailableSelected {
                    selected_scheduled_for,
                });
            Ok(DuePlan {
                occurrences,
                receipt,
                evaluated_through: now,
            })
        }
    }
}

#[cfg(test)]
#[allow(dead_code)]
fn scheduled_occurrence(
    scope: &OccurrenceIdentityScope,
    scheduled_for: DateTime<Utc>,
) -> Result<ScheduledOccurrence, ScheduleError> {
    Ok(ScheduledOccurrence {
        occurrence_id: occurrence_id(scope, scheduled_for)?,
        scheduled_for,
    })
}

fn instant_from_millis(at_ms: i64) -> Result<DateTime<Utc>, ScheduleError> {
    Utc.timestamp_millis_opt(at_ms)
        .single()
        .ok_or(ScheduleError::CalculationOverflow(
            "converting trigger atMs to a UTC instant",
        ))
}

fn next_raw(
    schedule: &Schedule,
    timezone: Tz,
    after: Option<DateTime<Utc>>,
) -> Result<Option<DateTime<Utc>>, ScheduleError> {
    match &schedule.trigger {
        TaskTrigger::Manual => Ok(None),
        TaskTrigger::Once { at_ms } => {
            let at = instant_from_millis(*at_ms)?;
            Ok((at >= schedule.starts_at && after.map_or(true, |value| at > value)).then_some(at))
        }
        TaskTrigger::Daily { at } => next_daily(schedule, timezone, after, *at, |_| true),
        TaskTrigger::Weekdays { at } => next_daily(schedule, timezone, after, *at, |weekday| {
            is_weekday(weekday)
        }),
        TaskTrigger::Weekly { weekdays, at } => {
            next_daily(schedule, timezone, after, *at, |weekday| {
                weekdays
                    .iter()
                    .any(|day| task_weekday_matches(*day, weekday))
            })
        }
        TaskTrigger::Monthly { day, at } => next_monthly(schedule, timezone, after, *day, *at),
    }
}

fn previous_scheduled_at(
    schedule: &Schedule,
    timezone: Tz,
    at: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, ScheduleError> {
    let mut upper = at;
    if let Some(ends_at) = schedule.bounds.ends_at {
        upper = upper.min(ends_at);
    }
    if let Some(max_occurrences) = schedule.bounds.max_occurrences {
        let Some(last_counted) = nth_raw(schedule, timezone, max_occurrences - 1)? else {
            return Ok(None);
        };
        upper = upper.min(last_counted);
    }
    previous_raw(schedule, timezone, upper)
}

fn nth_raw(
    schedule: &Schedule,
    timezone: Tz,
    ordinal: u32,
) -> Result<Option<DateTime<Utc>>, ScheduleError> {
    let Some(mut candidate) = next_raw(schedule, timezone, None)? else {
        return Ok(None);
    };
    for _ in 0..ordinal {
        let Some(next) = next_raw(schedule, timezone, Some(candidate))? else {
            return Ok(None);
        };
        candidate = next;
    }
    Ok(Some(candidate))
}

fn next_daily(
    schedule: &Schedule,
    timezone: Tz,
    after: Option<DateTime<Utc>>,
    time: TaskLocalTime,
    matches_day: impl Fn(Weekday) -> bool,
) -> Result<Option<DateTime<Utc>>, ScheduleError> {
    let anchor_date = schedule.starts_at.with_timezone(&timezone).date_naive();
    let mut date = after
        .filter(|value| *value >= schedule.starts_at)
        .map(|value| value.with_timezone(&timezone).date_naive())
        .unwrap_or(anchor_date)
        .max(anchor_date);

    for _ in 0..8 {
        if matches_day(date.weekday()) {
            let candidate = resolve_wall_time(timezone, date, time)?.scheduled_for;
            if candidate >= schedule.starts_at && after.map_or(true, |value| candidate > value) {
                return Ok(Some(candidate));
            }
        }
        date = add_days(date, 1)?;
    }
    Err(ScheduleError::SearchLimit(
        "weekly schedule did not produce a candidate within eight days",
    ))
}

fn next_monthly(
    schedule: &Schedule,
    timezone: Tz,
    after: Option<DateTime<Utc>>,
    day: u8,
    time: TaskLocalTime,
) -> Result<Option<DateTime<Utc>>, ScheduleError> {
    let anchor = schedule.starts_at.with_timezone(&timezone).date_naive();
    let start = after
        .filter(|value| *value >= schedule.starts_at)
        .map(|value| value.with_timezone(&timezone).date_naive())
        .unwrap_or(anchor);
    let (mut year, mut month) = if month_key(start) < month_key(anchor) {
        (anchor.year(), anchor.month())
    } else {
        (start.year(), start.month())
    };

    for _ in 0..24 {
        if u32::from(day) <= days_in_month(year, month) {
            let date = NaiveDate::from_ymd_opt(year, month, u32::from(day))
                .ok_or(ScheduleError::CalculationOverflow("building monthly date"))?;
            let candidate = resolve_wall_time(timezone, date, time)?.scheduled_for;
            if candidate >= schedule.starts_at && after.map_or(true, |value| candidate > value) {
                return Ok(Some(candidate));
            }
        }
        (year, month) = next_month(year, month)?;
    }
    Err(ScheduleError::SearchLimit(
        "monthly schedule did not produce a candidate within twenty-four months",
    ))
}

fn previous_raw(
    schedule: &Schedule,
    timezone: Tz,
    at: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, ScheduleError> {
    match &schedule.trigger {
        TaskTrigger::Manual => Ok(None),
        TaskTrigger::Once { at_ms } => {
            let once_at = instant_from_millis(*at_ms)?;
            Ok((once_at <= at && once_at >= schedule.starts_at).then_some(once_at))
        }
        TaskTrigger::Daily { at: wall_time } => {
            previous_daily(schedule, timezone, at, *wall_time, |_| true)
        }
        TaskTrigger::Weekdays { at: wall_time } => {
            previous_daily(schedule, timezone, at, *wall_time, is_weekday)
        }
        TaskTrigger::Weekly {
            weekdays,
            at: wall_time,
        } => previous_daily(schedule, timezone, at, *wall_time, |weekday| {
            weekdays
                .iter()
                .any(|day| task_weekday_matches(*day, weekday))
        }),
        TaskTrigger::Monthly { day, at: wall_time } => {
            previous_monthly(schedule, timezone, at, *day, *wall_time)
        }
    }
}

fn previous_daily(
    schedule: &Schedule,
    timezone: Tz,
    at: DateTime<Utc>,
    time: TaskLocalTime,
    matches_day: impl Fn(Weekday) -> bool,
) -> Result<Option<DateTime<Utc>>, ScheduleError> {
    let mut date = at.with_timezone(&timezone).date_naive();
    let anchor_date = schedule.starts_at.with_timezone(&timezone).date_naive();
    for _ in 0..8 {
        if date < anchor_date {
            return Ok(None);
        }
        if matches_day(date.weekday()) {
            let candidate = resolve_wall_time(timezone, date, time)?.scheduled_for;
            if candidate <= at && candidate >= schedule.starts_at {
                return Ok(Some(candidate));
            }
        }
        date = add_days(date, -1)?;
    }
    Ok(None)
}

fn previous_monthly(
    schedule: &Schedule,
    timezone: Tz,
    at: DateTime<Utc>,
    day: u8,
    time: TaskLocalTime,
) -> Result<Option<DateTime<Utc>>, ScheduleError> {
    let anchor = schedule.starts_at.with_timezone(&timezone).date_naive();
    let mut year = at.with_timezone(&timezone).year();
    let mut month = at.with_timezone(&timezone).month();
    for _ in 0..24 {
        if month_key(NaiveDate::from_ymd_opt(year, month, 1).ok_or(
            ScheduleError::CalculationOverflow("building previous monthly key"),
        )?) < month_key(anchor)
        {
            return Ok(None);
        }
        if u32::from(day) <= days_in_month(year, month) {
            let date = NaiveDate::from_ymd_opt(year, month, u32::from(day)).ok_or(
                ScheduleError::CalculationOverflow("building previous monthly date"),
            )?;
            let candidate = resolve_wall_time(timezone, date, time)?.scheduled_for;
            if candidate <= at && candidate >= schedule.starts_at {
                return Ok(Some(candidate));
            }
        }
        (year, month) = previous_month(year, month)?;
    }
    Ok(None)
}

fn within_bounds(
    schedule: &Schedule,
    timezone: Tz,
    candidate: DateTime<Utc>,
) -> Result<bool, ScheduleError> {
    if schedule
        .bounds
        .ends_at
        .is_some_and(|ends_at| candidate > ends_at)
    {
        return Ok(false);
    }
    let Some(max_occurrences) = schedule.bounds.max_occurrences else {
        return Ok(true);
    };
    Ok(occurrence_ordinal(schedule, timezone, candidate, max_occurrences)? < max_occurrences)
}

fn occurrence_ordinal(
    schedule: &Schedule,
    timezone: Tz,
    candidate: DateTime<Utc>,
    ceiling: u32,
) -> Result<u32, ScheduleError> {
    let Some(first) = next_raw(schedule, timezone, None)? else {
        return Ok(ceiling);
    };
    if candidate < first {
        return Ok(ceiling);
    }
    match &schedule.trigger {
        TaskTrigger::Manual => Ok(ceiling),
        TaskTrigger::Once { .. } => Ok(0),
        TaskTrigger::Daily { .. } => ordinal_from_days(first, candidate, timezone, 1, ceiling),
        TaskTrigger::Weekdays { .. } => {
            ordinal_from_matching_days(first, candidate, timezone, ceiling, is_weekday)
        }
        TaskTrigger::Weekly { weekdays, .. } => {
            ordinal_from_matching_days(first, candidate, timezone, ceiling, |weekday| {
                weekdays
                    .iter()
                    .any(|day| task_weekday_matches(*day, weekday))
            })
        }
        TaskTrigger::Monthly { day, .. } => {
            ordinal_from_months(first, candidate, timezone, *day, ceiling)
        }
    }
}

fn ordinal_from_days(
    first: DateTime<Utc>,
    candidate: DateTime<Utc>,
    timezone: Tz,
    every_days: u32,
    ceiling: u32,
) -> Result<u32, ScheduleError> {
    let first_date = first.with_timezone(&timezone).date_naive();
    let candidate_date = candidate.with_timezone(&timezone).date_naive();
    clamp_ordinal(
        candidate_date.signed_duration_since(first_date).num_days() / i64::from(every_days),
        ceiling,
    )
}

fn ordinal_from_matching_days(
    first: DateTime<Utc>,
    candidate: DateTime<Utc>,
    timezone: Tz,
    ceiling: u32,
    matches_day: impl Fn(Weekday) -> bool,
) -> Result<u32, ScheduleError> {
    let first_date = first.with_timezone(&timezone).date_naive();
    let candidate_date = candidate.with_timezone(&timezone).date_naive();
    let days = candidate_date.signed_duration_since(first_date).num_days();
    if days < 0 {
        return Ok(ceiling);
    }
    let full_weeks = days / 7;
    let mut per_week = 0i64;
    for offset in 0..7 {
        if matches_day(add_days(first_date, i64::from(offset))?.weekday()) {
            per_week += 1;
        }
    }
    let mut count = full_weeks * per_week;
    for offset in 0..=(days % 7) {
        if matches_day(add_days(first_date, full_weeks * 7 + offset)?.weekday()) {
            count += 1;
        }
    }
    clamp_ordinal(count - 1, ceiling)
}

fn ordinal_from_months(
    first: DateTime<Utc>,
    candidate: DateTime<Utc>,
    timezone: Tz,
    day: u8,
    ceiling: u32,
) -> Result<u32, ScheduleError> {
    let first_local = first.with_timezone(&timezone).date_naive();
    let candidate_local = candidate.with_timezone(&timezone).date_naive();
    let mut year = first_local.year();
    let mut month = first_local.month();
    let target = month_key(candidate_local);
    let mut ordinal = 0u32;
    loop {
        if u32::from(day) <= days_in_month(year, month) {
            if (year, month) == target {
                return Ok(ordinal);
            }
            ordinal = ordinal.saturating_add(1);
            if ordinal >= ceiling {
                return Ok(ceiling);
            }
        }
        (year, month) = next_month(year, month)?;
    }
}

fn clamp_ordinal(value: i64, ceiling: u32) -> Result<u32, ScheduleError> {
    if value < 0 {
        return Ok(ceiling);
    }
    let value = u64::try_from(value)
        .map_err(|_| ScheduleError::CalculationOverflow("ordinal conversion"))?;
    Ok(value.min(u64::from(ceiling)) as u32)
}

fn is_weekday(weekday: Weekday) -> bool {
    matches!(
        weekday,
        Weekday::Mon | Weekday::Tue | Weekday::Wed | Weekday::Thu | Weekday::Fri
    )
}

fn add_days(date: NaiveDate, days: i64) -> Result<NaiveDate, ScheduleError> {
    date.checked_add_signed(Duration::days(days))
        .ok_or(ScheduleError::CalculationOverflow(
            "advancing calendar date",
        ))
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .and_then(|next| next.pred_opt())
        .map(|last| last.day())
        .unwrap_or(31)
}

fn month_key(date: NaiveDate) -> (i32, u32) {
    (date.year(), date.month())
}

fn next_month(year: i32, month: u32) -> Result<(i32, u32), ScheduleError> {
    if month == 12 {
        Ok((
            year.checked_add(1)
                .ok_or(ScheduleError::CalculationOverflow("advancing year"))?,
            1,
        ))
    } else {
        Ok((year, month + 1))
    }
}

fn previous_month(year: i32, month: u32) -> Result<(i32, u32), ScheduleError> {
    if month == 1 {
        Ok((
            year.checked_sub(1)
                .ok_or(ScheduleError::CalculationOverflow("rewinding year"))?,
            12,
        ))
    } else {
        Ok((year, month - 1))
    }
}

fn task_weekday_matches(day: TaskWeekday, weekday: Weekday) -> bool {
    matches!(
        (day, weekday),
        (TaskWeekday::Monday, Weekday::Mon)
            | (TaskWeekday::Tuesday, Weekday::Tue)
            | (TaskWeekday::Wednesday, Weekday::Wed)
            | (TaskWeekday::Thursday, Weekday::Thu)
            | (TaskWeekday::Friday, Weekday::Fri)
            | (TaskWeekday::Saturday, Weekday::Sat)
            | (TaskWeekday::Sunday, Weekday::Sun)
    )
}
