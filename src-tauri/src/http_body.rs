/// Read a reqwest response body without trusting Content-Length. Chunked
/// responses and incorrect/missing length headers are rejected as soon as the
/// actual byte count would exceed `cap_bytes`.
pub(crate) async fn read_reqwest_body_bounded(
    mut response: reqwest::Response,
    cap_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    let cap_bytes = cap_bytes.max(1);
    if let Some(declared) = response.content_length() {
        if declared > cap_bytes as u64 {
            return Err(format!(
                "{label} declared {declared} bytes, exceeding the {cap_bytes}-byte cap"
            ));
        }
    }

    let mut body = Vec::with_capacity(
        response
            .content_length()
            .and_then(|length| usize::try_from(length).ok())
            .unwrap_or(0)
            .min(cap_bytes),
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("{label} body read failed: {error}"))?
    {
        append_bounded_chunk(&mut body, &chunk, cap_bytes, label)?;
    }
    Ok(body)
}

fn append_bounded_chunk(
    body: &mut Vec<u8>,
    chunk: &[u8],
    cap_bytes: usize,
    label: &str,
) -> Result<(), String> {
    let next_len = body
        .len()
        .checked_add(chunk.len())
        .ok_or_else(|| format!("{label} body length overflow"))?;
    if next_len > cap_bytes {
        return Err(format!(
            "{label} exceeded the {cap_bytes}-byte response cap"
        ));
    }
    body.extend_from_slice(chunk);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_http_body_accepts_bytes_at_the_limit() {
        let mut body = b"abc".to_vec();
        append_bounded_chunk(&mut body, b"def", 6, "fixture").unwrap();
        assert_eq!(body, b"abcdef");
    }

    #[test]
    fn bounded_http_body_rejects_chunked_overflow_before_append() {
        let mut body = b"abc".to_vec();
        let error = append_bounded_chunk(&mut body, b"defg", 6, "fixture").unwrap_err();
        assert!(error.contains("6-byte response cap"));
        assert_eq!(body, b"abc");
    }
}
