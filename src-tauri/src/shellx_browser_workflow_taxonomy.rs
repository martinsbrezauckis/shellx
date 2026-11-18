pub(crate) fn workflow_slug(value: &str, limit: usize) -> Option<String> {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= limit {
            break;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

pub(crate) fn canonical_workflow_task_type(value: Option<String>) -> Option<String> {
    let raw = value?.split_whitespace().collect::<Vec<_>>().join(" ");
    let slug = workflow_slug(&raw, 64)?;
    if slug == "signup" || slug.starts_with("signup-") || slug.starts_with("sign-up") {
        return Some("register".to_string());
    }
    if slug.starts_with("register") || slug.starts_with("registration") {
        return Some("register".to_string());
    }
    if slug == "signin" || slug.starts_with("signin-") || slug.starts_with("sign-in") {
        return Some("login".to_string());
    }
    if slug.starts_with("log-in") || slug.starts_with("login") {
        return Some("login".to_string());
    }
    let first = slug.split('-').next().unwrap_or(slug.as_str());
    let canonical = match first {
        "read" | "get" | "search" | "create" | "update" | "upload" | "download" | "fill"
        | "submit" | "buy" | "login" | "register" | "verify" | "store" | "delete" | "open"
        | "analyze" => first,
        "fetch" | "retrieve" | "copy" => "get",
        "find" => "search",
        "add" | "new" => "create",
        "edit" | "change" => "update",
        "signin" | "sign-in" | "sign" => "login",
        _ => slug.as_str(),
    };
    Some(canonical.to_string())
}

#[cfg(test)]
#[path = "../public/tests/inline/shellx_browser_workflow_taxonomy/tests.rs"]
mod tests;
