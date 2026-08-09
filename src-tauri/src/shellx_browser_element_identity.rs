pub(crate) const BROWSER_ELEMENT_IDENTITY_SCRIPT: &str = r#"
  const shellxIdentityClip = (value, max) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  const shellxIdentityEscapeCss = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };
  const shellxIdentityEscapeAttr = (value) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const shellxIdentityRole = (element) => {
    const tag = String(element?.localName || "").toLowerCase();
    const explicit = element?.getAttribute?.("role");
    if (explicit) return explicit;
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = String(element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (type === "password") return "password";
      return "textbox";
    }
    return tag || "control";
  };
  const shellxIdentitySegment = (element) => {
    if (!element?.localName) return "";
    const tag = element.localName.toLowerCase();
    if (element.id) return `${tag}#${shellxIdentityEscapeCss(element.id)}`;
    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test-id");
    if (testId) return `${tag}[data-testid="${shellxIdentityEscapeAttr(testId)}"]`;
    const name = element.getAttribute("name");
    if (name) return `${tag}[name="${shellxIdentityEscapeAttr(name)}"]`;
    const parent = element.parentElement || (element.parentNode?.nodeType === 11 ? element.parentNode : null);
    if (!parent) return tag;
    const same = Array.from(parent.children).filter((child) => child.localName === element.localName);
    return same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(element) + 1})` : tag;
  };
  const shellxElementDomPath = (element) => {
    const parts = [];
    let current = element;
    let depth = 0;
    while (current?.nodeType === 1 && depth < 16) {
      const segment = shellxIdentitySegment(current);
      if (segment) parts.unshift(segment);
      const parent = current.parentElement;
      if (parent) {
        current = parent;
      } else {
        const root = current.getRootNode?.();
        if (root?.host) {
          parts.unshift(">>>");
          current = root.host;
        } else if (root?.nodeType === 9) {
          let frame = null;
          try { frame = root.defaultView?.frameElement || null; } catch (_) { frame = null; }
          if (!frame) break;
          parts.unshift("::frame");
          current = frame;
        } else {
          break;
        }
      }
      depth += 1;
    }
    return shellxIdentityClip(
      parts.join(" > ").replace(/ > >>> > /g, " >>> ").replace(/ > ::frame > /g, " ::frame "),
      512
    );
  };
  const shellxElementShadowPath = (element) => {
    const hosts = [];
    let current = element;
    let depth = 0;
    while (current && depth < 8) {
      const root = current.getRootNode?.();
      if (!root?.host) break;
      hosts.unshift(shellxElementDomPath(root.host));
      current = root.host;
      depth += 1;
    }
    return hosts.filter(Boolean).slice(0, 8);
  };
  const shellxIdentityHash = (value) => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  };
  const shellxElementFingerprint = (element) => {
    if (!element?.localName) return null;
    const stableAttribute = (name) => shellxIdentityClip(element.getAttribute?.(name), 120);
    const stableAttributes = ["data-testid", "data-test-id", "id", "name", "aria-label", "placeholder"]
      .map((name) => [name, stableAttribute(name)])
      .filter(([, value]) => Boolean(value));
    const stableIdentity = stableAttributes.map(([name, value]) => `${name}=${value}`).join("~");
    const fallbackLabel = stableAttributes.length > 0 ? "" : shellxIdentityClip(element.innerText || element.textContent, 160);
    const raw = [
      element.localName.toLowerCase(),
      shellxIdentityRole(element),
      stableAttribute("type"),
      stableIdentity,
      fallbackLabel,
      shellxElementDomPath(element)
    ].join("|");
    const reverse = Array.from(raw).reverse().join("");
    return `fp-${shellxIdentityHash(raw)}${shellxIdentityHash(reverse)}`;
  };
  const shellxElementStableRefId = (element, prefix = "dom") => {
    const fingerprint = shellxElementFingerprint(element);
    return fingerprint ? `${prefix}-${fingerprint.slice(3)}` : null;
  };
  const shellxElementOptionValues = (element) => {
    if (String(element?.localName || "").toLowerCase() !== "select") return [];
    return Array.from(element.options || []).slice(0, 100).map((option) => shellxIdentityClip(option.value, 240));
  };
  const shellxElementIdentityMetadata = (element) => ({
    fingerprint: shellxElementFingerprint(element),
    domPath: shellxElementDomPath(element) || null,
    frameUrl: typeof shellxElementFrameUrl === "function" ? shellxElementFrameUrl(element) : location.href,
    shadowPath: shellxElementShadowPath(element),
    optionValues: shellxElementOptionValues(element)
  });
  const shellxElementFingerprintCheck = (element, expected) => {
    const expectedFingerprint = shellxIdentityClip(expected, 80) || null;
    const actualFingerprint = element ? shellxElementFingerprint(element) : null;
    return {
      expectedFingerprint,
      actualFingerprint,
      fingerprintMatches: expectedFingerprint ? actualFingerprint === expectedFingerprint : null
    };
  };
"#;

#[cfg(test)]
mod tests {
    use super::BROWSER_ELEMENT_IDENTITY_SCRIPT;

    #[test]
    fn identity_script_is_bounded_and_does_not_read_control_values() {
        assert!(BROWSER_ELEMENT_IDENTITY_SCRIPT.contains("shellxElementFingerprint"));
        assert!(BROWSER_ELEMENT_IDENTITY_SCRIPT.contains("shellxElementStableRefId"));
        assert!(BROWSER_ELEMENT_IDENTITY_SCRIPT.contains("shellxElementShadowPath"));
        assert!(!BROWSER_ELEMENT_IDENTITY_SCRIPT.contains("element.value"));
    }
}
