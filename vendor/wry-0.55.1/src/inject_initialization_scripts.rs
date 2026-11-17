// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! This is an internal implementation detail used by the Android backend to inject
//! initialization scripts when `addDocumentStartJavaScript` is not supported.

use base64::{prelude::BASE64_STANDARD, Engine};
use dom_query::Document;
use http::{
  header::{HeaderValue, CONTENT_SECURITY_POLICY, CONTENT_TYPE},
  Response as HttpResponse,
};
use sha2::{Digest, Sha256};
use std::borrow::Cow;

use crate::InitializationScript;

pub fn inject_scripts_into_html(
  mut response: HttpResponse<Cow<'static, [u8]>>,
  scripts: &[InitializationScript],
) -> HttpResponse<Cow<'static, [u8]>> {
  if scripts.is_empty() {
    return response;
  }

  let should_inject_scripts = response
    .headers()
    .get(CONTENT_TYPE)
    // Content-Type must begin with the media type, but is case-insensitive.
    // It may also be followed by any number of semicolon-delimited key value pairs.
    // We don't care about these here.
    // source: https://httpwg.org/specs/rfc9110.html#rfc.section.8.3.1
    .and_then(|content_type| content_type.to_str().ok())
    .map(|content_type_str| content_type_str.to_lowercase().starts_with("text/html"))
    .unwrap_or_default();

  if !should_inject_scripts {
    return response;
  }

  let document = Document::from(String::from_utf8_lossy(response.body()).as_ref());
  let csp = response.headers_mut().get_mut(CONTENT_SECURITY_POLICY);

  // Get or create head element
  let head = document.head().unwrap_or_else(|| {
    let html = document.html_root();
    let head = document.tree.new_element("head");
    html.prepend_child(&head);
    head
  });

  // Iterate in reverse order since we are prepending each script to the head tag
  let mut hashes = Vec::new();
  for script in scripts.iter().rev().map(|s| &s.script) {
    let script_tag = document.tree.new_element("script");
    script_tag.set_text(script.as_str());
    head.prepend_child(&script_tag);
    if csp.is_some() {
      hashes.push(hash_script(script));
    }
  }

  if let Some(csp) = csp {
    let csp_string = csp.to_str().unwrap().to_string();
    let csp_string = if csp_string.contains("script-src") {
      csp_string.replace("script-src", &format!("script-src {}", hashes.join(" ")))
    } else {
      format!("{csp_string} script-src {}", hashes.join(" "))
    };
    *csp = HeaderValue::from_str(&csp_string).unwrap();
  }

  *response.body_mut() = Cow::Owned(document.html().as_bytes().to_vec());
  response
}

fn hash_script(script: &str) -> String {
  let mut hasher = Sha256::new();
  hasher.update(script);
  let hash = hasher.finalize();
  format!("'sha256-{}'", BASE64_STANDARD.encode(hash))
}
