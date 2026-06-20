pub fn marker_was_leaked(haystack: &str, marker: &str) -> bool {
    !marker.is_empty() && haystack.contains(marker)
}
