// This focused fixture imports the complete Task model/scheduler modules by
// path; most durable-store types are intentionally outside its schedule-only
// scenarios.
#![allow(dead_code)]

#[path = "../src/task_model.rs"]
mod task_model;
#[path = "../src/task_schedule.rs"]
mod task_schedule;
#[path = "../src/task_time.rs"]
mod task_time;

use chrono::{DateTime, TimeZone, Utc};
use std::collections::BTreeSet;
use task_schedule::{
    next_scheduled_at, occurrence_id, plan_due_occurrences, MissedRunPolicy,
    OccurrenceIdentityScope, Schedule, ScheduleBounds, ScheduleDecision, TaskTrigger, TaskWeekday,
};
use task_time::{parse_iana_timezone, TaskLocalTime};

fn utc(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(year, month, day, hour, minute, 0)
        .single()
        .expect("valid UTC test instant")
}

fn schedule(timezone: &str, starts_at: DateTime<Utc>, trigger: TaskTrigger) -> Schedule {
    Schedule {
        timezone: timezone.to_string(),
        starts_at,
        trigger,
        bounds: ScheduleBounds::default(),
    }
}

fn scope() -> OccurrenceIdentityScope {
    OccurrenceIdentityScope {
        task_id: "task-42".to_string(),
        revision_id: "revision-3".to_string(),
    }
}

#[test]
fn validates_iana_names_without_accepting_offset_strings() {
    assert!(parse_iana_timezone("America/New_York").is_ok());
    assert!(parse_iana_timezone("+02:00").is_err());
    assert!(parse_iana_timezone(" America/New_York").is_err());
}

#[test]
fn manual_is_never_due_and_once_uses_task_store_at_ms() {
    let starts_at = utc(2026, 1, 1, 0, 0);
    let manual = schedule("UTC", starts_at, TaskTrigger::Manual);
    assert_eq!(
        next_scheduled_at(&manual, utc(2026, 1, 2, 0, 0)).unwrap(),
        None
    );

    let once_at = utc(2026, 1, 2, 9, 30);
    let once = schedule(
        "UTC",
        starts_at,
        TaskTrigger::Once {
            at_ms: once_at.timestamp_millis(),
        },
    );
    assert_eq!(next_scheduled_at(&once, starts_at).unwrap(), Some(once_at));
    assert_eq!(next_scheduled_at(&once, once_at).unwrap(), None);
}

#[test]
fn daily_spring_gap_shifts_forward_by_the_dst_delta() {
    let schedule = schedule(
        "America/New_York",
        utc(2026, 3, 7, 0, 0),
        TaskTrigger::Daily {
            at: TaskLocalTime::new(2, 30),
        },
    );

    let next = next_scheduled_at(&schedule, utc(2026, 3, 8, 0, 0))
        .unwrap()
        .expect("spring occurrence");
    assert_eq!(next, utc(2026, 3, 8, 7, 30));
}

#[test]
fn daily_fall_rollback_runs_the_repeated_wall_time_once() {
    let schedule = schedule(
        "America/New_York",
        utc(2026, 10, 31, 0, 0),
        TaskTrigger::Daily {
            at: TaskLocalTime::new(1, 30),
        },
    );

    let first = next_scheduled_at(&schedule, utc(2026, 11, 1, 0, 0))
        .unwrap()
        .expect("fall occurrence");
    assert_eq!(first, utc(2026, 11, 1, 5, 30));
    assert_eq!(
        next_scheduled_at(&schedule, first)
            .unwrap()
            .expect("next day"),
        utc(2026, 11, 2, 6, 30)
    );
}

#[test]
fn calendar_schedules_cover_weekdays_weekly_and_short_months() {
    let weekdays = schedule(
        "UTC",
        utc(2026, 1, 2, 12, 0),
        TaskTrigger::Weekdays {
            at: TaskLocalTime::new(9, 0),
        },
    );
    assert_eq!(
        next_scheduled_at(&weekdays, utc(2026, 1, 2, 12, 0)).unwrap(),
        Some(utc(2026, 1, 5, 9, 0))
    );

    let weekly = schedule(
        "UTC",
        utc(2026, 1, 1, 0, 0),
        TaskTrigger::Weekly {
            weekdays: vec![TaskWeekday::Monday, TaskWeekday::Thursday],
            at: TaskLocalTime::new(8, 0),
        },
    );
    assert_eq!(
        next_scheduled_at(&weekly, utc(2026, 1, 5, 8, 0)).unwrap(),
        Some(utc(2026, 1, 8, 8, 0))
    );

    let monthly = schedule(
        "UTC",
        utc(2026, 1, 1, 0, 0),
        TaskTrigger::Monthly {
            day: 31,
            at: TaskLocalTime::new(10, 0),
        },
    );
    assert_eq!(
        next_scheduled_at(&monthly, utc(2026, 3, 31, 10, 0)).unwrap(),
        Some(utc(2026, 5, 31, 10, 0))
    );
}

#[test]
fn end_date_and_count_are_inclusive_but_finite() {
    let mut count_limited = schedule(
        "UTC",
        utc(2026, 1, 1, 0, 0),
        TaskTrigger::Daily {
            at: TaskLocalTime::new(9, 0),
        },
    );
    count_limited.bounds.max_occurrences = Some(2);
    assert_eq!(
        next_scheduled_at(&count_limited, utc(2026, 1, 1, 0, 0)).unwrap(),
        Some(utc(2026, 1, 1, 9, 0))
    );
    assert_eq!(
        next_scheduled_at(&count_limited, utc(2026, 1, 1, 9, 0)).unwrap(),
        Some(utc(2026, 1, 2, 9, 0))
    );
    assert_eq!(
        next_scheduled_at(&count_limited, utc(2026, 1, 2, 9, 0)).unwrap(),
        None
    );

    let mut end_limited = count_limited.clone();
    end_limited.bounds.max_occurrences = None;
    end_limited.bounds.ends_at = Some(utc(2026, 1, 2, 9, 0));
    assert_eq!(
        next_scheduled_at(&end_limited, utc(2026, 1, 1, 9, 0)).unwrap(),
        Some(utc(2026, 1, 2, 9, 0))
    );
    assert_eq!(
        next_scheduled_at(&end_limited, utc(2026, 1, 2, 9, 0)).unwrap(),
        None
    );
}

#[test]
fn occurrence_identity_is_stable_and_revision_scoped() {
    let scheduled_for = utc(2026, 1, 1, 12, 0);
    let first = occurrence_id(&scope(), scheduled_for).unwrap();
    assert_eq!(first, occurrence_id(&scope(), scheduled_for).unwrap());

    let changed_revision = OccurrenceIdentityScope {
        task_id: "task-42".to_string(),
        revision_id: "revision-4".to_string(),
    };
    assert_ne!(
        first,
        occurrence_id(&changed_revision, scheduled_for).unwrap()
    );
    assert_eq!(
        first,
        task_model::deterministic_occurrence_id(
            &scope().task_id,
            &scope().revision_id,
            scheduled_for.timestamp_millis(),
        )
        .unwrap(),
        "scheduler and durable store must claim the same occurrence identity",
    );
}

#[test]
fn missed_run_policies_skip_run_once_or_require_attention() {
    let mut daily = schedule(
        "UTC",
        utc(2026, 1, 1, 0, 0),
        TaskTrigger::Daily {
            at: TaskLocalTime::new(5, 0),
        },
    );
    daily.bounds.max_occurrences = Some(10);
    let after = utc(2026, 1, 1, 5, 0);
    let now = utc(2026, 1, 5, 5, 30);

    let skipped = plan_due_occurrences(
        &daily,
        &scope(),
        after,
        now,
        MissedRunPolicy::Skip,
        &BTreeSet::new(),
    )
    .unwrap();
    assert!(skipped.occurrences.is_empty());
    assert_eq!(
        skipped.receipt.decisions,
        vec![ScheduleDecision::MissedWindowSkipped]
    );

    let run_once = plan_due_occurrences(
        &daily,
        &scope(),
        after,
        now,
        MissedRunPolicy::RunOnceWhenAvailable,
        &BTreeSet::new(),
    )
    .unwrap();
    assert_eq!(run_once.occurrences.len(), 1);
    assert_eq!(run_once.occurrences[0].scheduled_for, utc(2026, 1, 5, 5, 0));
    assert_eq!(
        run_once.receipt.schema_version,
        "shellx.task-schedule-decision.v1"
    );
    assert!(matches!(
        run_once.receipt.decisions.as_slice(),
        [
            ScheduleDecision::OccurrencePlanned { .. },
            ScheduleDecision::RunOnceWhenAvailableSelected { .. }
        ]
    ));

    let mut known = BTreeSet::new();
    known.insert(run_once.occurrences[0].occurrence_id.clone());
    let latest_known = plan_due_occurrences(
        &daily,
        &scope(),
        after,
        now,
        MissedRunPolicy::RunOnceWhenAvailable,
        &known,
    )
    .unwrap();
    assert!(latest_known.occurrences.is_empty());
    assert!(latest_known.receipt.decisions.iter().any(|decision| {
        matches!(decision, ScheduleDecision::KnownOccurrenceSuppressed { .. })
    }));
    assert!(latest_known.receipt.decisions.iter().any(|decision| {
        matches!(
            decision,
            ScheduleDecision::RunOnceWhenAvailableSelected {
                selected_scheduled_for: Some(_)
            }
        )
    }));

    let attention = plan_due_occurrences(
        &daily,
        &scope(),
        after,
        now,
        MissedRunPolicy::NeedsAttention,
        &BTreeSet::new(),
    )
    .unwrap();
    assert!(attention.occurrences.is_empty());
    assert_eq!(
        attention.receipt.decisions,
        vec![ScheduleDecision::NeedsAttentionRequired]
    );
}

#[test]
fn due_window_does_not_duplicate_fall_back_occurrences() {
    let schedule = schedule(
        "America/New_York",
        utc(2026, 10, 31, 0, 0),
        TaskTrigger::Daily {
            at: TaskLocalTime::new(1, 30),
        },
    );
    let plan = plan_due_occurrences(
        &schedule,
        &scope(),
        utc(2026, 11, 1, 4, 0),
        utc(2026, 11, 1, 7, 0),
        MissedRunPolicy::RunOnceWhenAvailable,
        &BTreeSet::new(),
    )
    .unwrap();
    assert_eq!(plan.occurrences.len(), 1);
    assert_eq!(plan.occurrences[0].scheduled_for, utc(2026, 11, 1, 5, 30));
}
