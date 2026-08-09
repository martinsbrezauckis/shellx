use serde::Serialize;
use std::collections::VecDeque;
use std::io::BufRead;
use std::path::{Path, PathBuf};

pub(crate) const MAX_SESSION_JSONL_TAIL_RECORDS: usize = 20_000;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionJsonlTail {
    pub lines: Vec<String>,
    pub omitted_lines: usize,
}

pub(crate) fn session_jsonl_path(session_id: &str) -> Result<PathBuf, String> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid session_id: {session_id}"));
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE unset".to_string())?;
    Ok(PathBuf::from(home)
        .join(".shellx")
        .join("sessions")
        .join(format!("{session_id}.jsonl")))
}

pub(crate) fn read_all_session_jsonl(session_id: &str) -> Result<Vec<String>, String> {
    let path = session_jsonl_path(session_id)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| format!("read failed: {e}"))?;
    Ok(crate::split_session_jsonl_records(&content))
}

pub(crate) fn read_session_jsonl_tail(
    session_id: &str,
    limit: usize,
) -> Result<SessionJsonlTail, String> {
    let path = session_jsonl_path(session_id)?;
    if !path.exists() {
        return Ok(SessionJsonlTail {
            lines: Vec::new(),
            omitted_lines: 0,
        });
    }
    read_session_jsonl_tail_from_path(&path, limit)
}

fn read_session_jsonl_tail_from_path(
    path: &Path,
    limit: usize,
) -> Result<SessionJsonlTail, String> {
    let safe_limit = limit.clamp(1, MAX_SESSION_JSONL_TAIL_RECORDS);
    let file = std::fs::File::open(path).map_err(|e| format!("read failed: {e}"))?;
    let mut tail = VecDeque::<String>::with_capacity(safe_limit);
    let mut total_records = 0usize;
    for physical_line in std::io::BufReader::new(file).lines() {
        let physical_line = physical_line.map_err(|e| format!("read failed: {e}"))?;
        for record in crate::split_session_jsonl_records(&physical_line) {
            total_records = total_records.saturating_add(1);
            tail.push_back(record);
            if tail.len() > safe_limit {
                tail.pop_front();
            }
        }
    }
    let lines = tail.into_iter().collect::<Vec<_>>();
    Ok(SessionJsonlTail {
        omitted_lines: total_records.saturating_sub(lines.len()),
        lines,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn tail_reader_is_bounded_and_recovers_adjacent_legacy_records() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("session.jsonl");
        let mut file = std::fs::File::create(&path).expect("create log");
        writeln!(
            file,
            r#"{{"t":1,"kind":"ui","payload":"a"}}{{"t":2,"kind":"ui","payload":"b"}}"#
        )
        .expect("write adjacent records");
        writeln!(file, r#"{{"t":3,"kind":"ui","payload":"c"}}"#).expect("write record");

        let tail = read_session_jsonl_tail_from_path(&path, 2).expect("read tail");
        assert_eq!(tail.omitted_lines, 1);
        assert_eq!(tail.lines.len(), 2);
        assert!(tail.lines[0].contains(r#""payload":"b""#));
        assert!(tail.lines[1].contains(r#""payload":"c""#));
    }

    #[test]
    fn tail_reader_ignores_malformed_records_and_reports_valid_omissions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"t\":1,\"kind\":\"ui\",\"payload\":\"a\"}\n",
                "not-json\n",
                "{\"t\":2,\"kind\":\"ui\",\"payload\":\"b\"}\n",
            ),
        )
        .expect("write log");

        let tail = read_session_jsonl_tail_from_path(&path, 1).expect("read tail");
        assert_eq!(tail.omitted_lines, 1);
        assert_eq!(tail.lines.len(), 1);
        assert!(tail.lines[0].contains(r#""payload":"b""#));
    }
}
