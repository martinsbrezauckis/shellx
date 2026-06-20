pub(crate) const BROWSER_ENGINE_OBSERVE_SCRIPT: &str = r#"
(() => {
  const clip = (value, max) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  const escapeCss = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };
  const escapeAttr = (value) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const selectorFor = (element) => {
    if (!element || !element.localName) return "";
    const uniqueSelector = (selector) => {
      if (!selector) return "";
      try { return document.querySelectorAll(selector).length === 1 ? selector : ""; } catch (_) { return ""; }
    };
    if (element.id) {
      const byId = uniqueSelector(`#${escapeCss(element.id)}`);
      if (byId) return byId;
    }
    const tagName = element.localName.toLowerCase();
    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test-id");
    if (testId) {
      const byTestId = uniqueSelector(`${tagName}[data-testid="${escapeAttr(testId)}"]`) || uniqueSelector(`[data-testid="${escapeAttr(testId)}"]`);
      if (byTestId) return byTestId;
    }
    const candidateAttrs = [];
    const name = element.getAttribute("name");
    const type = element.getAttribute("type");
    const autocomplete = element.getAttribute("autocomplete");
    const placeholder = element.getAttribute("placeholder");
    const ariaLabel = element.getAttribute("aria-label");
    if (["input", "textarea", "select"].includes(tagName)) {
      if (name && type) candidateAttrs.push(`${tagName}[type="${escapeAttr(type)}"][name="${escapeAttr(name)}"]`);
      if (name) candidateAttrs.push(`${tagName}[name="${escapeAttr(name)}"]`);
      if (autocomplete) candidateAttrs.push(`${tagName}[autocomplete="${escapeAttr(autocomplete)}"]`);
      if (placeholder) candidateAttrs.push(`${tagName}[placeholder="${escapeAttr(placeholder)}"]`);
      if (ariaLabel) candidateAttrs.push(`${tagName}[aria-label="${escapeAttr(ariaLabel)}"]`);
    } else if (ariaLabel) {
      candidateAttrs.push(`${tagName}[aria-label="${escapeAttr(ariaLabel)}"]`);
    }
    for (const candidate of candidateAttrs) {
      const unique = uniqueSelector(candidate);
      if (unique) return unique;
    }
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== document.documentElement && parts.length < 6) {
      let part = current.localName.toLowerCase();
      const currentTestId = current.getAttribute("data-testid") || current.getAttribute("data-test-id");
      if (currentTestId) {
        part += `[data-testid="${escapeAttr(currentTestId)}"]`;
        parts.unshift(part);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((child) => child.localName === current.localName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };
  const xpathFor = (element) => {
    if (!element || !element.localName) return "";
    if (element.id) return `//*[@id="${String(element.id).replace(/"/g, '\\"')}"]`;
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== document && parts.length < 16) {
      const tag = current.localName.toLowerCase();
      const parent = current.parentElement;
      const same = parent ? Array.from(parent.children).filter((child) => child.localName === current.localName) : [];
      const index = same.length > 1 ? `[${same.indexOf(current) + 1}]` : "";
      parts.unshift(`${tag}${index}`);
      current = parent;
    }
    return parts.length ? `/${parts.join("/")}` : "";
  };
  const looksLikeXpath = (selector) => /^(\.?\/\/|\/)/.test(String(selector || "").trim());
  const xpathMatches = (selector) => {
    if (!selector) return [];
    try {
      const snapshot = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const matches = [];
      for (let index = 0; index < snapshot.snapshotLength; index += 1) {
        const item = snapshot.snapshotItem(index);
        if (item && item.nodeType === 1) matches.push(item);
      }
      return matches;
    } catch (_) {
      return [];
    }
  };
  const xpathCount = (selector) => xpathMatches(selector).length;
  const queryCount = (selector) => {
    if (!selector) return 0;
    if (looksLikeXpath(selector)) return xpathCount(selector);
    try { return document.querySelectorAll(selector).length; } catch (_) { return 0; }
  };
  const primarySelectorFor = (element) => {
    const cssSelector = selectorFor(element);
    if (queryCount(cssSelector) === 1) return cssSelector;
    const xpath = xpathFor(element);
    if (xpathCount(xpath) === 1) return xpath;
    return queryCount(cssSelector) > 0 ? cssSelector : xpath;
  };
  const roleFor = (element) => {
    const tag = (element.localName || "").toLowerCase();
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      if (type === "password") return "password";
      return "textbox";
    }
    return "control";
  };
  const isSensitiveField = (element) => {
    try {
      if (window.__shellxTaintedControls?.has?.(element)) return true;
    } catch (_) {}
    const tag = (element.localName || "").toLowerCase();
    const type = (element.getAttribute("type") || "").toLowerCase();
    const metadata = [
      type,
      element.getAttribute("autocomplete") || "",
      element.getAttribute("name") || "",
      element.getAttribute("id") || "",
      element.getAttribute("aria-label") || "",
      element.getAttribute("placeholder") || ""
    ].join(" ").toLowerCase();
    if (tag === "input" && ["password", "hidden"].includes(type)) return true;
    return /\b(pass(word)?|secret|token|api[-_ ]?key|credential|otp|pin)\b/.test(metadata);
  };
  const labelFor = (element) => {
    const aria = element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder");
    if (aria) return clip(aria, 160);
    const id = element.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for="${String(id).replace(/"/g, '\\"')}"]`);
      if (label) return clip(label.innerText || label.textContent, 160);
    }
    if (isSensitiveField(element)) return clip(element.localName || "field", 160);
    return clip(element.innerText || element.textContent || element.value || element.href || element.localName, 160);
  };
  const valueFor = (element) => {
    const tag = (element.localName || "").toLowerCase();
    if (isSensitiveField(element)) return null;
    if (tag === "a") return element.href || null;
    if ("value" in element) return clip(element.value, 240);
    return null;
  };
  const actionFor = (role) => {
    if (role === "textbox" || role === "password") return "fillRef";
    if (role === "combobox") return "select";
    return "clickRef";
  };
  const fieldKindFor = (element) => {
    const tag = (element.localName || "").toLowerCase();
    if (tag === "textarea") return "textarea";
    if (tag === "select") return element.multiple ? "select-multiple" : "select-one";
    if (element.isContentEditable) return "contenteditable";
    return (element.getAttribute("type") || "text").toLowerCase();
  };
  const boundsFor = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x * 100) / 100,
      y: Math.round(rect.y * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100
    };
  };
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return Boolean(rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > 0);
  };
  const isEnabled = (element) => !Boolean(element.disabled || element.getAttribute("aria-disabled") === "true");
  const isEditable = (element) => {
    const tag = (element.localName || "").toLowerCase();
    if (element.isContentEditable) return true;
    if (tag === "textarea" || tag === "select") return isEnabled(element);
    if (tag !== "input") return false;
    const type = (element.getAttribute("type") || "text").toLowerCase();
    return !["button", "submit", "reset", "checkbox", "radio", "file", "hidden"].includes(type) && isEnabled(element) && !element.readOnly;
  };
  const locatorSuggestionsFor = (element, selector, role, name) => {
    const suggestions = [];
    const push = (kind, value, strict = true, matchCount = 1) => {
      const clean = clip(value, 240);
      if (!clean || suggestions.some((item) => item.kind === kind && item.value === clean)) return;
      suggestions.push({ kind, value: clean, strict, matchCount });
    };
    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test-id");
    if (testId) push("testId", testId, queryCount(`[data-testid="${String(testId).replace(/"/g, '\\"')}"]`) === 1, queryCount(`[data-testid="${String(testId).replace(/"/g, '\\"')}"]`));
    if (role && name) push("role", `${role}:${name}`, true, 1);
    const id = element.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for="${String(id).replace(/"/g, '\\"')}"]`);
      if (label) push("label", clip(label.innerText || label.textContent, 160), true, 1);
    }
    const placeholder = element.getAttribute("placeholder");
    if (placeholder) push("placeholder", placeholder, true, 1);
    if (name && !["textbox", "password", "combobox"].includes(role)) push("text", name, false, 1);
    if (selector) push(looksLikeXpath(selector) ? "xpath" : "css", selector, queryCount(selector) === 1, queryCount(selector));
    const xpath = xpathFor(element);
    if (xpath) push("xpath", xpath, false, 1);
    return suggestions.slice(0, 8);
  };
  const byteLength = (value) => {
    try {
      if (typeof TextEncoder === "function") return new TextEncoder().encode(String(value || "")).length;
    } catch (_) {}
    return String(value || "").length;
  };
  const controls = Array.from(document.querySelectorAll(
    "a,button,input,textarea,select,[role='button'],[role='link'],[role='radio'],[role='checkbox'],[role='option'],[role='tab'],[role='menuitem'],[role='switch'],[tabindex]:not([tabindex='-1']),[contenteditable='true']"
  ));
  const refs = controls.slice(0, 200).map((element, index) => {
    const role = roleFor(element);
    const selector = primarySelectorFor(element);
    const name = labelFor(element) || `${role} ${index + 1}`;
    return {
      refId: `dom-${index + 1}`,
      role,
      label: name,
      name,
      testId: element.getAttribute("data-testid") || element.getAttribute("data-test-id") || null,
      selector,
      value: valueFor(element),
      action: actionFor(role),
      locatorSuggestions: locatorSuggestionsFor(element, selector, role, name),
      bounds: boundsFor(element),
      visible: isVisible(element),
      enabled: isEnabled(element),
      editable: isEditable(element),
      frameId: "main",
      strictMatchCount: queryCount(selector)
    };
  }).filter((ref) => ref.selector);
  const directTextForSecretCandidate = (element) => {
    if (!element) return "";
    const tag = (element.localName || "").toLowerCase();
    if (["input", "textarea"].includes(tag) && "value" in element) return String(element.value || "");
    const direct = Array.from(element.childNodes || [])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => String(node.textContent || ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (direct) return direct;
    if ((element.children?.length || 0) <= 1) return String(element.innerText || element.textContent || "");
    return "";
  };
  const surroundingSecretContext = (element) => {
    const parts = [];
    let current = element;
    for (let depth = 0; current && depth < 4; depth += 1) {
      const text = clip(current.innerText || current.textContent || "", 500);
      if (text) parts.push(text);
      current = current.parentElement;
    }
    return parts.join(" ").toLowerCase();
  };
  const controlLabel = (element) => [
    element.getAttribute?.("aria-label") || "",
    element.getAttribute?.("title") || "",
    element.getAttribute?.("data-testid") || "",
    element.getAttribute?.("data-test-id") || "",
    element.innerText || "",
    element.textContent || ""
  ].join(" ").replace(/\s+/g, " ").trim();
  const isSecretCopyControl = (element) => {
    if (!element || !isVisible(element)) return false;
    const role = roleFor(element);
    if (!["button", "link", "menuitem"].includes(role)) return false;
    const label = controlLabel(element).toLowerCase();
    if (!/\bcopy\b/.test(label)) return false;
    if (!/\b(api[-_ ]?key|key|secret|token|credential|auth key)\b/.test(label)) return false;
    const context = `${label} ${surroundingSecretContext(element)}`;
    return /\b(api[-_ ]?key|secret|token|credential|auth key)\b/.test(context);
  };
  const looksLikeSecretCandidate = (value) => {
    const clean = String(value || "").trim();
    if (clean.length < 12 || clean.length > 256) return false;
    if (/\s{2,}|\n|\r/.test(clean)) return false;
    if (!/[A-Za-z]/.test(clean) || !/[0-9]/.test(clean)) return false;
    if (/^(api|key|token|secret|copy|show|hide|delete)$/i.test(clean)) return false;
    if (/^AQ\.[A-Za-z0-9._-]{8,}$/.test(clean)) return true;
    if (/^(sk|pk|xai|AIza|ghp|glpat|hf|firecrawl)[A-Za-z0-9._-]{8,}$/i.test(clean)) return true;
    const compact = clean.replace(/[^A-Za-z0-9]/g, "");
    const uniqueChars = new Set(clean.replace(/[^A-Za-z0-9]/g, "").split("")).size;
    return compact.length >= 16 && uniqueChars >= 10 && /[._:-]/.test(clean);
  };
  const secretTextNodeElements = () => {
    const elements = [];
    try {
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      while (elements.length < 40) {
        const node = walker.nextNode();
        if (!node) break;
        const candidate = String(node.textContent || "").replace(/\s+/g, " ").trim();
        if (!looksLikeSecretCandidate(candidate)) continue;
        const element = node.parentElement;
        if (!element || !isVisible(element)) continue;
        const context = surroundingSecretContext(element);
        if (!/\b(api[-_ ]?key|secret|token|credential|auth key)\b/.test(context)) continue;
        elements.push(element);
      }
    } catch (_) {}
    return elements;
  };
  const secretCandidateElements = [
    ...Array.from(document.querySelectorAll(
    "input,textarea,code,pre,kbd,samp,span,p,dd,td,div,[role='textbox']"
    )),
    ...secretTextNodeElements()
  ];
  const secretCandidateRefs = secretCandidateElements
    .filter((element) => isVisible(element))
    .map((element) => {
      const candidate = directTextForSecretCandidate(element).replace(/\s+/g, " ").trim();
      const textNodeCandidate = Array.from(element.childNodes || [])
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim())
        .find((value) => looksLikeSecretCandidate(value));
      if (!looksLikeSecretCandidate(candidate) && !textNodeCandidate) return null;
      const context = surroundingSecretContext(element);
      if (!/\b(api[-_ ]?key|secret|token|credential|auth key)\b/.test(context)) return null;
      const cssSelector = selectorFor(element);
      const selector = queryCount(cssSelector) === 1 ? cssSelector : xpathFor(element);
      if (!selector) return null;
      return { element, selector };
    })
    .filter(Boolean)
    .filter((candidate, index, all) => all.findIndex((item) => item.selector === candidate.selector) === index)
    .slice(0, 20)
    .map((candidate, index) => {
      const strictMatchCount = queryCount(candidate.selector);
      return {
        refId: `secret-${index + 1}`,
        role: "secret",
        label: "Capturable secret value (redacted)",
        name: "Capturable secret value",
        testId: candidate.element.getAttribute("data-testid") || candidate.element.getAttribute("data-test-id") || null,
        selector: candidate.selector,
        value: null,
        action: "capturePageSecretToVault",
        locatorSuggestions: locatorSuggestionsFor(candidate.element, candidate.selector, "secret", "Capturable secret value"),
        bounds: boundsFor(candidate.element),
        visible: true,
        enabled: true,
        editable: false,
        frameId: "main",
        strictMatchCount
      };
    });
  const secretCopyControlRefs = Array.from(document.querySelectorAll("button,a,[role='button'],[role='menuitem']"))
    .filter((element) => isSecretCopyControl(element))
    .map((element) => {
      const cssSelector = selectorFor(element);
      const selector = queryCount(cssSelector) === 1 ? cssSelector : xpathFor(element);
      if (!selector) return null;
      return { element, selector };
    })
    .filter(Boolean)
    .filter((candidate, index, all) => all.findIndex((item) => item.selector === candidate.selector) === index)
    .slice(0, 20)
    .map((candidate, index) => {
      const strictMatchCount = queryCount(candidate.selector);
      return {
        refId: `secret-${secretCandidateRefs.length + index + 1}`,
        role: "secret",
        label: "Capturable secret copy control (redacted)",
        name: "Capturable secret copy control",
        testId: candidate.element.getAttribute("data-testid") || candidate.element.getAttribute("data-test-id") || null,
        selector: candidate.selector,
        value: null,
        action: "capturePageSecretToVault",
        locatorSuggestions: locatorSuggestionsFor(candidate.element, candidate.selector, "secret", "Capturable secret copy control"),
        bounds: boundsFor(candidate.element),
        visible: true,
        enabled: !candidate.element.disabled,
        editable: false,
        frameId: "main",
        strictMatchCount
      };
    });
  const prioritizedSecretRefs = [...secretCopyControlRefs, ...secretCandidateRefs]
    .map((candidate, index) => ({ ...candidate, refId: `secret-${index + 1}` }));
  refs.push(...prioritizedSecretRefs.filter((candidate) => !refs.some((ref) => ref.selector === candidate.selector && ref.action === candidate.action)));
  const rawText = document.body?.innerText || document.documentElement?.innerText || "";
  const text = rawText.trim().slice(0, 20000);
  const title = document.title || location.href || "Untitled browser page";
  const domSummary = {
    links: document.querySelectorAll("a[href]").length,
    buttons: document.querySelectorAll("button,input[type='button'],input[type='submit'],input[type='reset'],[role='button']").length,
    inputs: document.querySelectorAll("input,textarea,select,[contenteditable='true']").length,
    forms: document.querySelectorAll("form").length,
    tables: document.querySelectorAll("table").length,
    headings: document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']").length,
    textBytes: byteLength(text)
  };
  const formFields = Array.from(document.querySelectorAll("input,textarea,select,[contenteditable='true']")).slice(0, 200).map((element) => {
    const selector = primarySelectorFor(element);
    if (!selector) return null;
    const ref = refs.find((item) => item.selector === selector);
    return {
      refId: ref?.refId || null,
      selector,
      label: labelFor(element) || fieldKindFor(element),
      fieldKind: fieldKindFor(element),
      value: valueFor(element),
      required: Boolean(element.required || element.getAttribute("aria-required") === "true"),
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      autocomplete: element.getAttribute("autocomplete") || null,
      formAction: element.form?.action || null
    };
  }).filter(Boolean);
  const accessibilityTree = refs.slice(0, 200).map((ref) => ({
    refId: ref.refId,
    role: ref.role,
    label: ref.label,
    selector: ref.selector || null,
    action: ref.action || null
  }));
  return {
    url: location.href,
    title,
    text,
    markdown: `# ${title}\n\n${text}`,
    refs,
    domSummary,
    formFields,
    accessibilityTree,
    privacyStats: window.__shellxPrivacyStats || null
  };
})()
"#;

pub(crate) const BROWSER_ENGINE_CONTROL_SCRIPT: &str = r#"
(() => {
  const request = __SHELLX_BROWSER_REQUEST__;
  const clip = (value, max) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  const result = (ok, status, message, extra = {}) => ({
    ok,
    status,
    message,
    url: location.href,
    title: document.title || location.href,
    ...extra
  });
  const ensureShellxPermissionReporter = () => {
    try {
      const queue = () => {
        try {
          const existing = window.__shellxPermissionRequests;
          if (Array.isArray(existing)) return existing;
          Object.defineProperty(window, "__shellxPermissionRequests", {
            value: [],
            writable: false,
            configurable: false
          });
          return window.__shellxPermissionRequests;
        } catch {
          window.__shellxPermissionRequests = window.__shellxPermissionRequests || [];
          return window.__shellxPermissionRequests;
        }
      };
      const report = (permissionKind) => {
        try {
          const requests = queue();
          requests.push({
            permissionKind: String(permissionKind || "unknown"),
            url: String(window.location?.href || ""),
            userInitiated: Boolean(navigator.userActivation?.isActive),
            createdAtMs: Date.now()
          });
          if (requests.length > 50) requests.splice(0, requests.length - 50);
        } catch (_) {}
      };
      if (typeof Notification !== "undefined") {
        const descriptor = Object.getOwnPropertyDescriptor(Notification, "requestPermission");
        const original = descriptor?.value;
        if (typeof original === "function" && !original.__shellxWrapped) {
          const wrapped = function(...args) {
            report("notifications");
            return Reflect.apply(original, this, args);
          };
          Object.defineProperty(wrapped, "__shellxWrapped", { value: true });
          Object.defineProperty(Notification, "requestPermission", {
            configurable: true,
            writable: true,
            value: wrapped
          });
        }
      }
      const geolocation = navigator.geolocation;
      if (geolocation && typeof geolocation.getCurrentPosition === "function" && !geolocation.getCurrentPosition.__shellxWrapped) {
        const originalGetCurrentPosition = geolocation.getCurrentPosition.bind(geolocation);
        const wrappedGetCurrentPosition = (...args) => {
          report("geolocation");
          return originalGetCurrentPosition(...args);
        };
        Object.defineProperty(wrappedGetCurrentPosition, "__shellxWrapped", { value: true });
        geolocation.getCurrentPosition = wrappedGetCurrentPosition;
      }
      if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function" && !navigator.mediaDevices.getUserMedia.__shellxWrapped) {
        const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        const wrappedGetUserMedia = (constraints, ...rest) => {
          const kind = constraints?.video ? "camera" : constraints?.audio ? "microphone" : "media";
          report(kind);
          return originalGetUserMedia(constraints, ...rest);
        };
        Object.defineProperty(wrappedGetUserMedia, "__shellxWrapped", { value: true });
        navigator.mediaDevices.getUserMedia = wrappedGetUserMedia;
      }
    } catch (_) {}
  };
  const looksLikeXpath = (selector) => /^(\.?\/\/|\/)/.test(String(selector || "").trim());
  const xpathMatches = (selector) => {
    if (!selector) return [];
    try {
      const snapshot = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const matches = [];
      for (let index = 0; index < snapshot.snapshotLength; index += 1) {
        const item = snapshot.snapshotItem(index);
        if (item && item.nodeType === 1) matches.push(item);
      }
      return matches;
    } catch (_) {
      return [];
    }
  };
  const target = () => {
    if (!request.selector) return { element: null, strictMatchCount: 0 };
    if (looksLikeXpath(request.selector)) {
      const matches = xpathMatches(request.selector);
      return { element: matches[0] || null, strictMatchCount: matches.length };
    }
    try {
      const matches = Array.from(document.querySelectorAll(request.selector));
      return { element: matches[0] || null, strictMatchCount: matches.length };
    } catch (_) {
      return { element: null, strictMatchCount: 0 };
    }
  };
  const dispatchTextEvents = (element, value, inputType = "insertText") => {
    try {
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: value }));
    } catch (_) {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const dispatchBeforeTextInput = (element, value, inputType = "insertText") => {
    try {
      return element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data: value }));
    } catch (_) {
      return element.dispatchEvent(new Event("beforeinput", { bubbles: true, cancelable: true }));
    }
  };
  const setNativeValue = (element, value) => {
    const tag = (element.localName || "").toLowerCase();
    const prototype = tag === "textarea" ? window.HTMLTextAreaElement?.prototype : window.HTMLInputElement?.prototype;
    const setter = prototype && Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) {
      setter.call(element, value);
    } else {
      element.value = value;
    }
  };
  const replaceContentEditableText = (element, value) => {
    element.focus?.();
    if (dispatchBeforeTextInput(element, value) === false) return false;
    try {
      const selection = window.getSelection?.();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } catch (_) {}
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, value);
    } catch (_) {
      inserted = false;
    }
    if (!inserted) element.textContent = value;
    dispatchTextEvents(element, value);
    return true;
  };
  const markShellxTaintedControl = (element) => {
    const kind = String(request.sensitiveKind || "").toLowerCase();
    if (!["vaulttainted", "credentialuse", "profilecard"].includes(kind)) return;
    try {
      if (!window.__shellxTaintedControls) window.__shellxTaintedControls = new WeakSet();
      window.__shellxTaintedControls.add(element);
    } catch (_) {}
  };
  const visibleText = () => String(document.body?.innerText || document.documentElement?.innerText || "");
  const secretCopyContext = (element) => {
    const parts = [labelFor(element), element?.getAttribute?.("title") || "", element?.getAttribute?.("data-testid") || "", element?.getAttribute?.("data-test-id") || ""];
    let current = element;
    for (let depth = 0; current && depth < 4; depth += 1) {
      parts.push(current.innerText || current.textContent || "");
      current = current.parentElement;
    }
    return parts.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
  };
  const isTrustedSecretCopyControl = (element) => {
    if (!element || !isEnabled(element)) return false;
    const role = roleFor(element);
    if (!["button", "link", "menuitem"].includes(role)) return false;
    const label = labelFor(element).toLowerCase();
    const title = String(element.getAttribute?.("title") || "").toLowerCase();
    const testId = String(element.getAttribute?.("data-testid") || element.getAttribute?.("data-test-id") || "").toLowerCase();
    const ownText = `${label} ${title} ${testId}`;
    if (!/\bcopy\b/.test(ownText)) return false;
    if (!/\b(api[-_ ]?key|key|secret|token|credential|auth key)\b/.test(ownText)) return false;
    return /\b(api[-_ ]?key|secret|token|credential|auth key)\b/.test(secretCopyContext(element));
  };
  const capturedSecretValue = (element) => {
    const mode = String(request.key || "valueOrText").toLowerCase();
    if (!element) return "";
    if (mode === "href") return String(element.href || element.getAttribute?.("href") || "");
    if (mode === "text") return String(element.innerText || element.textContent || "");
    if (mode === "attribute") {
      const attr = String(request.value || "").trim();
      return attr ? String(element.getAttribute?.(attr) || "") : "";
    }
    if ("value" in element) {
      const value = String(element.value || "");
      if (value.trim()) return value;
    }
    return String(element.innerText || element.textContent || "");
  };
  const boundsFor = (element) => {
    if (!element || !element.getBoundingClientRect) return null;
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x * 100) / 100,
      y: Math.round(rect.y * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100
    };
  };
  const escapeCss = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };
  const escapeAttr = (value) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const selectorFor = (element) => {
    if (!element || !element.localName) return "";
    const uniqueSelector = (selector) => {
      if (!selector) return "";
      try { return document.querySelectorAll(selector).length === 1 ? selector : ""; } catch (_) { return ""; }
    };
    if (element.id) {
      const byId = uniqueSelector(`#${escapeCss(element.id)}`);
      if (byId) return byId;
    }
    const tagName = element.localName.toLowerCase();
    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test-id");
    if (testId) {
      return uniqueSelector(`${tagName}[data-testid="${escapeAttr(testId)}"]`) || uniqueSelector(`[data-testid="${escapeAttr(testId)}"]`);
    }
    const name = element.getAttribute("name");
    if (name) {
      const byName = uniqueSelector(`${tagName}[name="${escapeAttr(name)}"]`);
      if (byName) return byName;
    }
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) {
      const byAria = uniqueSelector(`${tagName}[aria-label="${escapeAttr(ariaLabel)}"]`);
      if (byAria) return byAria;
    }
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== document.documentElement && parts.length < 5) {
      let part = current.localName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((child) => child.localName === current.localName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };
  const roleFor = (element) => {
    const tag = (element?.localName || "").toLowerCase();
    const explicit = element?.getAttribute?.("role");
    if (explicit) return explicit;
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      if (type === "password") return "password";
      return "textbox";
    }
    return tag || "element";
  };
  const labelFor = (element) => {
    if (!element) return "";
    const aria = element.getAttribute?.("aria-label");
    if (aria) return clip(aria, 120);
    const labelledBy = element.getAttribute?.("aria-labelledby");
    if (labelledBy) {
      const value = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "")
        .join(" ");
      if (value.trim()) return clip(value, 120);
    }
    return clip(element.innerText || element.textContent || element.getAttribute?.("title") || element.getAttribute?.("name") || "", 120);
  };
  const isEnabled = (element) => !Boolean(element?.disabled || element?.getAttribute?.("aria-disabled") === "true");
  const isEditable = (element) => {
    if (!element) return false;
    const tag = (element.localName || "").toLowerCase();
    if (element.isContentEditable) return true;
    if (tag === "textarea" || tag === "select") return isEnabled(element);
    if (tag !== "input") return false;
    const type = (element.getAttribute("type") || "text").toLowerCase();
    return !["button", "submit", "reset", "checkbox", "radio", "file", "hidden"].includes(type) && isEnabled(element) && !element.readOnly;
  };
  const nativeInputRecommendedForClick = (element) => {
    if (!element) return false;
    const tag = (element.localName || "").toLowerCase();
    if (element.closest?.("a[href],button,summary,label")) return false;
    if (["button", "select", "textarea"].includes(tag)) return false;
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "checkbox", "radio", "file"].includes(type)) return false;
    }
    return true;
  };
  const coordinateActionability = (action) => {
    const x = Number(request.x);
    const y = Number(request.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { error: "viewport coordinates x and y are required" };
    }
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      return { error: "viewport coordinates are outside the visible page" };
    }
    const element = document.elementFromPoint(x, y);
    const selector = selectorFor(element) || null;
    return {
      actionability: {
        attached: Boolean(element),
        visible: true,
        stable: true,
        enabled: true,
        editable: action === "typeText",
        inViewport: true,
        receivesEvents: true,
        strictMatchCount: 1,
        selector,
        bounds: { x, y, width: 1, height: 1 },
        coveringElement: element ? {
          selector,
          role: roleFor(element) || null,
          label: labelFor(element) || null,
          bounds: boundsFor(element)
        } : null,
        failedChecks: element ? [] : ["attached"]
      }
    };
  };
  const actionabilityFor = (element, selector, strictMatchCount, action) => {
    const attached = Boolean(element && document.documentElement.contains(element));
    const rect = attached ? element.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
    const style = attached ? window.getComputedStyle(element) : null;
    const visible = Boolean(attached && rect.width > 0 && rect.height > 0 && style?.display !== "none" && style?.visibility !== "hidden" && Number(style?.opacity || 1) > 0);
    const enabled = attached ? isEnabled(element) : false;
    const editable = attached ? isEditable(element) : false;
    const inViewport = Boolean(visible && rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth);
    let receivesEvents = false;
    let coveringElement = null;
    if (inViewport) {
      const x = Math.min(Math.max(rect.left + rect.width / 2, 0), Math.max(window.innerWidth - 1, 0));
      const y = Math.min(Math.max(rect.top + rect.height / 2, 0), Math.max(window.innerHeight - 1, 0));
      const hit = document.elementFromPoint(x, y);
      receivesEvents = Boolean(hit && (hit === element || element.contains(hit) || hit.contains(element)));
      if (hit && !receivesEvents) {
        coveringElement = {
          selector: selectorFor(hit) || null,
          role: roleFor(hit) || null,
          label: labelFor(hit) || null,
          bounds: boundsFor(hit)
        };
      }
    }
    const check = {
      attached,
      visible,
      stable: visible,
      enabled,
      editable,
      inViewport,
      receivesEvents,
      strictMatchCount,
      selector: selector || null,
      bounds: attached ? boundsFor(element) : null,
      coveringElement,
      failedChecks: []
    };
    const needsEditable = action === "fillRef" || action === "type";
    if (!attached) check.failedChecks.push("attached");
    if (strictMatchCount !== 1 && selector) check.failedChecks.push("strict");
    if (!visible && action !== "scroll") check.failedChecks.push("visible");
    if (!enabled && ["click", "clickRef", "fillRef", "type", "select", "press"].includes(action)) check.failedChecks.push("enabled");
    if (needsEditable && !editable) check.failedChecks.push("editable");
    if (!inViewport && action !== "scroll") check.failedChecks.push("inViewport");
    if (!receivesEvents && ["click", "clickRef"].includes(action)) check.failedChecks.push("receivesEvents");
    return check;
  };
  const verifyExpectation = () => {
    const expectationType = String(request.key || "text");
    const value = String(request.value || "");
    const info = target();
    const failures = [];
    let passed = false;
    let checkedText = null;
    let checkedUrl = location.href;
    if (expectationType === "url") {
      passed = value ? location.href.includes(value) : true;
      if (!passed) failures.push("url");
    } else if (expectationType === "element") {
      const actionability = actionabilityFor(info.element, request.selector, info.strictMatchCount, "waitFor");
      passed = Boolean(info.element && actionability.visible);
      if (!passed) failures.push("element");
    } else if (expectationType === "table") {
      const table = info.element?.matches?.("table") ? info.element : (info.element?.querySelector?.("table") || document.querySelector("table"));
      checkedText = table ? String(table.innerText || table.textContent || "") : "";
      passed = Boolean(table) && (!value || checkedText.includes(value));
      if (!passed) failures.push("table");
    } else if (expectationType === "schema") {
      let schema = {};
      try { schema = value ? JSON.parse(value) : {}; } catch (_) { failures.push("schemaJson"); }
      const text = visibleText();
      checkedText = text.slice(0, 500);
      if (schema.text && !text.includes(String(schema.text))) failures.push("text");
      if (schema.urlContains && !location.href.includes(String(schema.urlContains))) failures.push("url");
      if (Array.isArray(schema.selectors)) {
        for (const selector of schema.selectors) {
          try {
            const element = document.querySelector(String(selector));
            const check = actionabilityFor(element, String(selector), element ? document.querySelectorAll(String(selector)).length : 0, "waitFor");
            if (!element || !check.visible) failures.push(`selector:${selector}`);
          } catch (_) {
            failures.push(`selector:${selector}`);
          }
        }
      }
      passed = failures.length === 0;
    } else {
      checkedText = visibleText();
      passed = value ? checkedText.includes(value) : true;
      if (!passed) failures.push("text");
    }
    return {
      expectationType,
      passed,
      selector: request.selector || null,
      checkedText,
      checkedUrl,
      failures
    };
  };
  const isVisibleTextElement = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
  };
  const snippetAround = (text, index, length) => {
    if (index < 0) return null;
    const start = Math.max(0, index - 80);
    const end = Math.min(text.length, index + length + 80);
    return text.slice(start, end).replace(/\s+/g, " ").trim();
  };
  const findTextOnPage = () => {
    const query = String(request.value || "");
    const caseSensitive = String(request.key || "").toLowerCase() === "casesensitive";
    const bodyText = visibleText();
    const haystack = caseSensitive ? bodyText : bodyText.toLocaleLowerCase();
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    if (!needle) {
      return {
        query,
        matchCount: 0,
        activeIndex: null,
        snippet: null,
        scrolled: false,
        caseSensitive
      };
    }
    let matchCount = 0;
    let cursor = 0;
    while (cursor <= haystack.length) {
      const index = haystack.indexOf(needle, cursor);
      if (index < 0) break;
      matchCount += 1;
      cursor = index + Math.max(needle.length, 1);
      if (matchCount >= 1000) break;
    }
    let scrolled = false;
    if (matchCount > 0 && document.body) {
      const selectors = "h1,h2,h3,h4,p,li,td,th,a,button,label,summary,output,[aria-live],span,div,article,section,[role='button'],[role='link'],[role='status']";
      const elements = Array.from(document.body.querySelectorAll(selectors)).slice(0, 5000);
      const first = elements.find((element) => {
        if (!isVisibleTextElement(element)) return false;
        const text = String(element.innerText || element.textContent || "");
        return (caseSensitive ? text : text.toLocaleLowerCase()).includes(needle);
      });
      if (first) {
        first.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        scrolled = true;
      }
    }
    const firstIndex = haystack.indexOf(needle);
    return {
      query,
      matchCount,
      activeIndex: matchCount > 0 ? 0 : null,
      snippet: snippetAround(bodyText, firstIndex, query.length),
      scrolled,
      caseSensitive
    };
  };
  try {
    if (request.action === "goBack") {
      history.back();
      return result(true, "applied", "history.back requested");
    }
    if (request.action === "goForward") {
      history.forward();
      return result(true, "applied", "history.forward requested");
    }
    if (request.action === "reload") {
      setTimeout(() => location.reload(), 0);
      return result(true, "applied", "reload requested");
    }
    if (request.action === "scroll") {
      const { element, strictMatchCount } = target();
      const actionability = actionabilityFor(element, request.selector, strictMatchCount, request.action);
      if (element) {
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      } else {
        const delta = Number(request.value || 600);
        window.scrollBy(0, Number.isFinite(delta) ? delta : 600);
      }
      return result(true, "applied", "scroll applied", { actionability });
    }
    if (request.action === "waitFor") {
      const { element, strictMatchCount } = target();
      const needle = String(request.value || "");
      const found = Boolean(element) || (needle && visibleText().includes(needle));
      const actionability = actionabilityFor(element, request.selector, strictMatchCount, request.action);
      return result(found, found ? "applied" : "notFound", found ? "waitFor matched" : "waitFor target not found", { actionability });
    }
    if (request.action === "extractTable") {
      const { element, strictMatchCount } = target();
      const table = element?.matches?.("table") ? element : (element?.querySelector?.("table") || document.querySelector("table"));
      if (!table) return result(false, "notFound", "table not found");
      const actionability = actionabilityFor(table, request.selector, strictMatchCount || 1, request.action);
      const rows = Array.from(table.querySelectorAll("tr")).slice(0, 200).map((row) =>
        Array.from(row.querySelectorAll("th,td")).slice(0, 50).map((cell) => String(cell.innerText || cell.textContent || "").trim())
      );
      return result(true, "applied", "table extracted", { actionability, extractedText: JSON.stringify(rows) });
    }
    if (request.action === "verify") {
      const verification = verifyExpectation();
      return result(verification.passed, verification.passed ? "applied" : "failed", verification.passed ? "verification passed" : "verification failed", { verification });
    }
    if (request.action === "findText") {
      const findResult = findTextOnPage();
      const found = findResult.matchCount > 0;
      return result(found, found ? "applied" : "notFound", found ? "text found" : "text not found", { findResult });
    }
    if (request.action === "clickAt" || request.action === "typeText") {
      const coordinate = coordinateActionability(request.action);
      if (coordinate.error) return result(false, "invalid", coordinate.error);
      if (coordinate.actionability.failedChecks.length > 0) {
        return result(false, "notActionable", "viewport coordinate did not resolve to a page element", { actionability: coordinate.actionability });
      }
      return result(true, "applied", request.action === "typeText" ? "viewport text target prepared" : "viewport click target prepared", {
        actionability: coordinate.actionability,
        nativeInputRecommended: true
      });
    }
    const { element, strictMatchCount } = target();
    if (!element) return result(false, "notFound", "target selector not found");
    element.scrollIntoView?.({ block: "center", inline: "center", behavior: "instant" });
    const actionability = actionabilityFor(element, request.selector, strictMatchCount, request.action);
    if (actionability.failedChecks.length > 0) {
      const forceClick = Boolean(request.force)
        && (request.action === "click" || request.action === "clickRef")
        && actionability.failedChecks.every((check) => check === "receivesEvents");
      if (!forceClick) {
        return result(false, "notActionable", "target failed actionability checks", { actionability });
      }
      actionability.failedChecks = [];
    }
    if (request.action === "click" || request.action === "clickRef") {
      ensureShellxPermissionReporter();
      element.click();
      return result(true, "applied", request.force ? "force click applied" : "click applied", {
        actionability,
        nativeInputRecommended: Boolean(request.force) || nativeInputRecommendedForClick(element)
      });
    }
    if (request.action === "capturePageSecretToVault") {
      const captured = capturedSecretValue(element).trim();
      if (captured && !isTrustedSecretCopyControl(element)) {
        return result(true, "applied", "page secret captured for Vault deposit", { actionability, extractedText: captured });
      }
      if (isTrustedSecretCopyControl(element)) {
        ensureShellxPermissionReporter();
        element.click();
        return result(true, "clipboardRequired", "secret copy control invoked for Vault deposit", { actionability });
      }
      if (!captured) return result(false, "empty", "target did not contain a capturable value", { actionability });
      return result(true, "applied", "page secret captured for Vault deposit", { actionability, extractedText: captured });
    }
    if (request.action === "fillRef" || request.action === "type") {
      const value = String(request.value || "");
      element.focus?.();
      markShellxTaintedControl(element);
      if (element.isContentEditable) {
        if (!replaceContentEditableText(element, value)) {
          return result(false, "blocked", "text input was cancelled by the page", { actionability });
        }
      } else if ("value" in element) {
        if (dispatchBeforeTextInput(element, value) === false) {
          return result(false, "blocked", "text input was cancelled by the page", { actionability });
        }
        setNativeValue(element, value);
        dispatchTextEvents(element, value);
      } else {
        element.textContent = value;
        dispatchTextEvents(element, value);
      }
      return result(true, "applied", "text value applied", { actionability });
    }
    if (request.action === "select") {
      if (!("value" in element)) return result(false, "notSupported", "target is not selectable");
      element.focus?.();
      element.value = String(request.value || "");
      dispatchTextEvents(element);
      return result(true, "applied", "selection applied", { actionability });
    }
    if (request.action === "press") {
      const key = String(request.key || request.value || "Enter");
      element.focus?.();
      element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
      return result(true, "applied", `key ${key} dispatched`, { actionability });
    }
    return result(false, "unsupported", `unsupported action ${request.action}`);
  } catch (error) {
    return result(false, "error", error instanceof Error ? error.message : String(error));
  }
})()
"#;

#[cfg(test)]
mod tests {
    use super::BROWSER_ENGINE_OBSERVE_SCRIPT;

    #[test]
    fn observe_script_exposes_redacted_secret_capture_refs() {
        assert!(BROWSER_ENGINE_OBSERVE_SCRIPT.contains("secretCandidateRefs"));
        assert!(BROWSER_ENGINE_OBSERVE_SCRIPT.contains("secretCopyControlRefs"));
        assert!(BROWSER_ENGINE_OBSERVE_SCRIPT.contains("capturePageSecretToVault"));
        assert!(BROWSER_ENGINE_OBSERVE_SCRIPT.contains("Capturable secret value"));
        assert!(BROWSER_ENGINE_OBSERVE_SCRIPT.contains("Capturable secret copy control"));
        assert!(super::BROWSER_ENGINE_CONTROL_SCRIPT.contains("clipboardRequired"));
        assert!(!BROWSER_ENGINE_OBSERVE_SCRIPT.contains("AQ.example-secret"));
    }
}
