use super::*;

// ───── search_tool (inventory discovery) ─────
//
// Two modes:
// * full_inventory=true → returns every spec in `tools/list` shape
//   (debugging only; capabilities_summary is the normal broad map).
// * (default) → returns at most `limit` (default 5)
// matching specs ranked by substring, plus
// a `total_hidden_tools` count so grok
// knows how many it didn't see.
//
// The default mode is intentionally narrow to match grok's existing
// "fishing" pattern (it's used to seeing a short list and asking for
// more); the `full_inventory` flag is the escape hatch for exhaustive
// schema drift debugging, not routine planning.

/// `search_tool` body. See module-level notes.
pub(super) async fn tool_search_tool(args: Value) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(5) as usize;
    let full = args
        .get("full_inventory")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let all = tool_specs();
    if full {
        // No filtering, no pagination. Returned in the same shape as
        // tools/list so grok can splice it in without translation.
        return Ok(json!({
            "tools": all,
            "total": all.len(),
            "mode": "full_inventory",
        }));
    }

    let mut filtered: Vec<(i32, Value)> = if query.is_empty() {
        all.iter().cloned().map(|spec| (0, spec)).collect()
    } else {
        all.iter()
            .filter_map(|spec| {
                let name = spec
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let desc = spec
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let score = if name == query {
                    100
                } else if name.starts_with(&query) {
                    90
                } else if name.contains(&query) {
                    80
                } else if desc.contains(&query) {
                    10
                } else {
                    return None;
                };
                Some((score, spec.clone()))
            })
            .collect()
    };
    filtered.sort_by(|(left_score, left), (right_score, right)| {
        right_score.cmp(left_score).then_with(|| {
            let left_name = left.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let right_name = right.get("name").and_then(|v| v.as_str()).unwrap_or("");
            left_name.cmp(right_name)
        })
    });

    let total_matched = filtered.len();
    let returned: Vec<Value> = filtered
        .into_iter()
        .take(limit)
        .map(|(_, spec)| spec)
        .collect();
    let hidden = total_matched.saturating_sub(returned.len());

    Ok(json!({
        "tools": returned,
        "total_matched": total_matched,
        "total_hidden_tools": hidden,
        "mode": "ranked",
        "query": query,
        "limit": limit,
        "hint": if hidden > 0 {
            format!("{} tools matched but were hidden - narrow `query` for exact schemas, then call host_read or host_act with that tool name as `action` and its fields inside `params`; Browser actions use browser_read/browser_act. Call capabilities_summary for a compact map; use full_inventory=true only for exhaustive schema debugging", hidden)
        } else {
            "Use the returned exact schema through host_read/host_act action+params, or browser_read/browser_act for Browser tools.".to_string()
        },
    }))
}
