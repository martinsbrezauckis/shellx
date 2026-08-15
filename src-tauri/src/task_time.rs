//! Pure timezone and wall-clock primitives for the future task scheduler.
//!
//! This module deliberately has no clock, persistence, or Tauri dependency.
//! The scheduler receives every instant from its caller, which keeps restart
//! reconciliation and tests deterministic.

use chrono::{
    DateTime, Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, Offset, TimeZone, Utc,
};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::fmt;

pub use crate::task_model::TaskLocalTime;

/// A deliberately finite search covers modern DST gaps and exceptional date
/// skips while preventing malformed input from turning time resolution into an
/// unbounded loop.
pub const MAX_DST_GAP_SEARCH_MINUTES: i64 = 48 * 60;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScheduleError {
    InvalidTimeZone(String),
    InvalidWallTime { hour: u8, minute: u8 },
    InvalidSchedule(String),
    CalculationOverflow(&'static str),
    SearchLimit(&'static str),
}

impl ScheduleError {
    pub(crate) fn invalid(detail: impl Into<String>) -> Self {
        Self::InvalidSchedule(detail.into())
    }
}

impl fmt::Display for ScheduleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTimeZone(name) => write!(formatter, "invalid IANA timezone: {name}"),
            Self::InvalidWallTime { hour, minute } => {
                write!(formatter, "invalid wall time {hour:02}:{minute:02}")
            }
            Self::InvalidSchedule(detail) => write!(formatter, "invalid task schedule: {detail}"),
            Self::CalculationOverflow(detail) => {
                write!(formatter, "task schedule overflow: {detail}")
            }
            Self::SearchLimit(detail) => write!(formatter, "task schedule search limit: {detail}"),
        }
    }
}

impl std::error::Error for ScheduleError {}

pub(crate) fn validate_local_time(time: TaskLocalTime) -> Result<NaiveTime, ScheduleError> {
    NaiveTime::from_hms_opt(time.hour.into(), time.minute.into(), 0).ok_or(
        ScheduleError::InvalidWallTime {
            hour: time.hour,
            minute: time.minute,
        },
    )
}

/// The documented, deterministic handling for wall-clock DST edge cases.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WallTimeResolution {
    Exact,
    /// Repeated wall times map to their first elapsed-time occurrence only.
    AmbiguousEarlier,
    /// A missing wall time is advanced by the offset change across the gap.
    NonexistentShiftedForward,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedWallTime {
    pub scheduled_for: DateTime<Utc>,
    pub resolution: WallTimeResolution,
}

/// Parse exactly the IANA database name accepted by `chrono-tz`; offsets and
/// host-local aliases are intentionally not accepted as task timezone values.
pub fn parse_iana_timezone(name: &str) -> Result<Tz, ScheduleError> {
    if name.is_empty() || name.trim() != name {
        return Err(ScheduleError::InvalidTimeZone(name.to_string()));
    }
    name.parse::<Tz>()
        .map_err(|_| ScheduleError::InvalidTimeZone(name.to_string()))
}

/// Resolve a requested local date/time without consulting the host clock.
///
/// Fall-back ambiguity chooses the earlier elapsed-time instant. Spring gaps
/// preserve the requested position through the gap: 02:30 in a one-hour gap
/// becomes 03:30, rather than silently becoming the first valid 03:00.
pub fn resolve_wall_time(
    timezone: Tz,
    date: NaiveDate,
    time: TaskLocalTime,
) -> Result<ResolvedWallTime, ScheduleError> {
    let local = NaiveDateTime::new(date, validate_local_time(time)?);
    match timezone.from_local_datetime(&local) {
        LocalResult::Single(value) => Ok(resolved(value, WallTimeResolution::Exact)),
        LocalResult::Ambiguous(first, second) => Ok(resolved(
            earlier(first, second),
            WallTimeResolution::AmbiguousEarlier,
        )),
        LocalResult::None => resolve_nonexistent_wall_time(timezone, local),
    }
}

fn resolve_nonexistent_wall_time(
    timezone: Tz,
    local: NaiveDateTime,
) -> Result<ResolvedWallTime, ScheduleError> {
    let before = nearest_valid(timezone, local, -1, false)?;
    let after = nearest_valid(timezone, local, 1, true)?;
    let offset_change = i64::from(after.offset().fix().local_minus_utc())
        - i64::from(before.offset().fix().local_minus_utc());
    let shifted = local
        .checked_add_signed(Duration::seconds(offset_change))
        .ok_or(ScheduleError::CalculationOverflow(
            "shifting a missing wall time",
        ))?;

    match timezone.from_local_datetime(&shifted) {
        LocalResult::Single(value) => Ok(resolved(
            value,
            WallTimeResolution::NonexistentShiftedForward,
        )),
        LocalResult::Ambiguous(first, second) => Ok(resolved(
            earlier(first, second),
            WallTimeResolution::NonexistentShiftedForward,
        )),
        LocalResult::None => Err(ScheduleError::SearchLimit(
            "shifted wall time remained nonexistent",
        )),
    }
}

fn nearest_valid(
    timezone: Tz,
    local: NaiveDateTime,
    direction: i64,
    choose_earlier: bool,
) -> Result<DateTime<Tz>, ScheduleError> {
    for minute in 1..=MAX_DST_GAP_SEARCH_MINUTES {
        let delta = Duration::minutes(direction * minute);
        let Some(candidate) = local.checked_add_signed(delta) else {
            break;
        };
        match timezone.from_local_datetime(&candidate) {
            LocalResult::Single(value) => return Ok(value),
            LocalResult::Ambiguous(first, second) => {
                return Ok(if choose_earlier {
                    earlier(first, second)
                } else {
                    later(first, second)
                });
            }
            LocalResult::None => {}
        }
    }
    Err(ScheduleError::SearchLimit(
        "could not find a valid local time around a timezone transition",
    ))
}

fn resolved(value: DateTime<Tz>, resolution: WallTimeResolution) -> ResolvedWallTime {
    ResolvedWallTime {
        scheduled_for: value.with_timezone(&Utc),
        resolution,
    }
}

fn earlier(first: DateTime<Tz>, second: DateTime<Tz>) -> DateTime<Tz> {
    if first <= second {
        first
    } else {
        second
    }
}

fn later(first: DateTime<Tz>, second: DateTime<Tz>) -> DateTime<Tz> {
    if first >= second {
        first
    } else {
        second
    }
}
