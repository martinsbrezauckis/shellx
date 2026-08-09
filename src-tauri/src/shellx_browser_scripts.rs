pub(crate) const BROWSER_ENGINE_OBSERVE_SCRIPT: &str = r#"
(() => {
  __SHELLX_ELEMENT_IDENTITY__
  __SHELLX_DOM_TRAVERSAL__
  const clip = (value, max) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  const selectorFor = shellxLocalSelectorFor;
  const xpathFor = shellxLocalXpathFor;
  const looksLikeXpath = shellxLooksLikeXpath;
  const queryCount = (selector, element) => shellxRootSelectorMatches(element ? shellxElementQueryRoot(element) : document, selector).length;
  const primarySelectorFor = shellxPrimarySelectorFor;
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
      if (shellxElementWindow(element).__shellxTaintedControls?.has?.(element)) return true;
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
      const label = shellxElementQueryRoot(element).querySelector(`label[for="${String(id).replace(/"/g, '\\"')}"]`);
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
  const fieldIntentFor = (element) => {
    const kind = fieldKindFor(element);
    const label = labelFor(element);
    const meta = [
      kind,
      element.getAttribute("autocomplete") || "",
      element.getAttribute("name") || "",
      element.getAttribute("id") || "",
      element.getAttribute("aria-label") || "",
      element.getAttribute("placeholder") || "",
      label || ""
    ].join(" ").toLowerCase();
    if (/\b(one-time-code|otp|mfa|2fa|verification code|security code)\b/.test(meta)) return "otp";
    if (/\b(api[-_ ]?key|access token|auth token|bearer|client secret|secret key)\b/.test(meta)) return "apiKey";
    if (/\bnew-password\b/.test(meta) || /\b(new|create|choose).{0,20}password\b/.test(meta)) return "newPassword";
    if (/\b(confirm|repeat|verify).{0,20}password\b/.test(meta)) return "confirmPassword";
    if (kind === "password" || /\bcurrent-password\b/.test(meta) || /\bpassword\b/.test(meta)) return "password";
    if (kind === "email" || /\bemail\b/.test(meta)) return "email";
    if (/\b(user(name)?|login)\b/.test(meta)) return "username";
    if (/\b(given-name|first name|forename)\b/.test(meta)) return "firstName";
    if (/\b(family-name|last name|surname)\b/.test(meta)) return "lastName";
    if (/\b(full name|display name|contact name)\b/.test(meta)) return "fullName";
    if (/\b(organi[sz]ation|company|workspace|team)\b/.test(meta)) return "organization";
    if (/\b(address-line2|address 2|suite|apartment|unit)\b/.test(meta)) return "addressLine2";
    if (/\b(address-line1|address 1|street|address)\b/.test(meta)) return "addressLine1";
    if (/\b(city|locality)\b/.test(meta)) return "city";
    if (/\b(postal|zip)\b/.test(meta)) return "postalCode";
    if (/\b(country|country-name)\b/.test(meta)) return "country";
    if (/\b(tel|phone|mobile)\b/.test(meta)) return "phone";
    if (/\b(url|website|homepage)\b/.test(meta)) return "url";
    if (/\b(cc-number|card number|credit card|payment card)\b/.test(meta)) return "paymentCard";
    if (kind === "search" || /\b(search|query)\b/.test(meta)) return "search";
    if (kind === "checkbox") return "checkbox";
    if (kind === "radio") return "radio";
    if (kind.startsWith("select")) return "choice";
    return "generic";
  };
  const formKeyFor = (element, index) => {
    const form = element.form;
    if (form) {
      return shellxDomLocatorFor(form) || form.action || `form-${index}`;
    }
    const container = element.closest?.("[role='form'],form,section,main,article,[data-testid],[data-test-id]");
    if (container) {
      const locator = shellxDomLocatorFor(container);
      if (locator) return locator;
    }
    return "page";
  };
  const groupKindFor = (fields) => {
    const intents = new Set(fields.map((field) => field.intent));
    if (intents.has("apiKey")) return "apiKey";
    if (intents.has("otp")) return "verification";
    if (intents.has("paymentCard")) return "payment";
    if (intents.has("password") && (intents.has("email") || intents.has("username"))) return "login";
    if (intents.has("newPassword") || intents.has("confirmPassword")) return "signup";
    if (["addressLine1", "city", "postalCode", "country"].some((intent) => intents.has(intent))) return "address";
    if (["firstName", "lastName", "fullName", "organization", "phone", "url"].some((intent) => intents.has(intent))) return "profile";
    if (intents.has("search")) return "search";
    return "generic";
  };
  const formFieldGroupLabel = (groupKind) => {
    switch (groupKind) {
      case "apiKey": return "API key or token form";
      case "verification": return "Verification code form";
      case "payment": return "Payment form";
      case "login": return "Login form";
      case "signup": return "Signup form";
      case "address": return "Address form";
      case "profile": return "Profile form";
      case "search": return "Search form";
      default: return "Form fields";
    }
  };
  const boundsFor = (element) => {
    const rect = shellxGlobalRectFor(element);
    return {
      x: Math.round(rect.x * 100) / 100,
      y: Math.round(rect.y * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100
    };
  };
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = shellxElementWindow(element).getComputedStyle(element);
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
    const root = shellxElementQueryRoot(element);
    const suggestions = [];
    const push = (kind, value, strict = true, matchCount = 1) => {
      const clean = clip(value, 240);
      if (!clean || suggestions.some((item) => item.kind === kind && item.value === clean)) return;
      suggestions.push({ kind, value: clean, strict, matchCount });
    };
    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test-id");
    if (testId) push("testId", testId, queryCount(`[data-testid="${String(testId).replace(/"/g, '\\"')}"]`, element) === 1, queryCount(`[data-testid="${String(testId).replace(/"/g, '\\"')}"]`, element));
    if (role && name) push("role", `${role}:${name}`, true, 1);
    const id = element.getAttribute("id");
    if (id) {
      const label = root.querySelector(`label[for="${String(id).replace(/"/g, '\\"')}"]`);
      if (label) push("label", clip(label.innerText || label.textContent, 160), true, 1);
    }
    const placeholder = element.getAttribute("placeholder");
    if (placeholder) push("placeholder", placeholder, true, 1);
    if (name && !["textbox", "password", "combobox"].includes(role)) push("text", name, false, 1);
    if (selector) push(looksLikeXpath(selector) ? "xpath" : "css", selector, queryCount(selector, element) === 1, queryCount(selector, element));
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
  const controls = shellxDeepQueryAll(
    "a,button,input,textarea,select,[role='button'],[role='link'],[role='radio'],[role='checkbox'],[role='option'],[role='tab'],[role='menuitem'],[role='switch'],[tabindex]:not([tabindex='-1']),[contenteditable='true']"
  , 500);
  const refs = controls.slice(0, 200).map((element, index) => {
    const role = roleFor(element);
    const selector = primarySelectorFor(element);
    const name = labelFor(element) || `${role} ${index + 1}`;
    return {
      refId: shellxElementStableRefId(element) || `dom-${index + 1}`,
      role,
      label: name,
      name,
      testId: element.getAttribute("data-testid") || element.getAttribute("data-test-id") || null,
      selector,
      locator: shellxDomLocatorFor(element),
      ...shellxElementIdentityMetadata(element),
      value: valueFor(element),
      action: actionFor(role),
      locatorSuggestions: locatorSuggestionsFor(element, selector, role, name),
      bounds: boundsFor(element),
      visible: isVisible(element),
      enabled: isEnabled(element),
      editable: isEditable(element),
      frameId: shellxElementFrameId(element),
      strictMatchCount: queryCount(selector, element)
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
    for (const contextRoot of shellxOpenDom().contexts.map((context) => context.root)) {
      try {
        const ownerDocument = contextRoot.nodeType === 9 ? contextRoot : contextRoot.ownerDocument;
        const walker = ownerDocument.createTreeWalker(contextRoot, 4);
        while (elements.length < 40) {
          const node = walker.nextNode();
          if (!node) break;
          const candidate = String(node.textContent || "").replace(/\s+/g, " ").trim();
          if (!looksLikeSecretCandidate(candidate)) continue;
          const element = node.parentElement;
          if (!element || !isVisible(element)) continue;
          const secretContext = surroundingSecretContext(element);
          if (/\b(api[-_ ]?key|secret|token|credential|auth key)\b/.test(secretContext)) elements.push(element);
        }
      } catch (_) {}
      if (elements.length >= 40) break;
    }
    return elements;
  };
  const secretCandidateElements = [
    ...shellxDeepQueryAll("input,textarea,code,pre,kbd,samp,span,p,dd,td,div,[role='textbox']", 1000),
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
      const selector = queryCount(cssSelector, element) === 1 ? cssSelector : xpathFor(element);
      if (!selector) return null;
      return { element, selector, locator: shellxDomLocatorFor(element) };
    })
    .filter(Boolean)
    .filter((candidate, index, all) => all.findIndex((item) => item.locator === candidate.locator) === index)
    .slice(0, 20)
    .map((candidate, index) => {
      const strictMatchCount = queryCount(candidate.selector, candidate.element);
      return {
        refId: `secret-${index + 1}`,
        role: "secret",
        label: "Capturable secret value (redacted)",
        name: "Capturable secret value",
        testId: candidate.element.getAttribute("data-testid") || candidate.element.getAttribute("data-test-id") || null,
        selector: candidate.selector,
        locator: candidate.locator,
        ...shellxElementIdentityMetadata(candidate.element),
        value: null,
        action: "capturePageSecretToVault",
        locatorSuggestions: locatorSuggestionsFor(candidate.element, candidate.selector, "secret", "Capturable secret value"),
        bounds: boundsFor(candidate.element),
        visible: true,
        enabled: true,
        editable: false,
        frameId: shellxElementFrameId(candidate.element),
        strictMatchCount
      };
    });
  const secretCopyControlRefs = shellxDeepQueryAll("button,a,[role='button'],[role='menuitem']", 1000)
    .filter((element) => isSecretCopyControl(element))
    .map((element) => {
      const cssSelector = selectorFor(element);
      const selector = queryCount(cssSelector, element) === 1 ? cssSelector : xpathFor(element);
      if (!selector) return null;
      return { element, selector, locator: shellxDomLocatorFor(element) };
    })
    .filter(Boolean)
    .filter((candidate, index, all) => all.findIndex((item) => item.locator === candidate.locator) === index)
    .slice(0, 20)
    .map((candidate, index) => {
      const strictMatchCount = queryCount(candidate.selector, candidate.element);
      return {
        refId: `secret-${secretCandidateRefs.length + index + 1}`,
        role: "secret",
        label: "Capturable secret copy control (redacted)",
        name: "Capturable secret copy control",
        testId: candidate.element.getAttribute("data-testid") || candidate.element.getAttribute("data-test-id") || null,
        selector: candidate.selector,
        locator: candidate.locator,
        ...shellxElementIdentityMetadata(candidate.element),
        value: null,
        action: "capturePageSecretToVault",
        locatorSuggestions: locatorSuggestionsFor(candidate.element, candidate.selector, "secret", "Capturable secret copy control"),
        bounds: boundsFor(candidate.element),
        visible: true,
        enabled: !candidate.element.disabled,
        editable: false,
        frameId: shellxElementFrameId(candidate.element),
        strictMatchCount
      };
    });
  const prioritizedSecretRefs = [...secretCopyControlRefs, ...secretCandidateRefs]
    .map((candidate, index) => ({ ...candidate, refId: `secret-${index + 1}` }));
  refs.push(...prioritizedSecretRefs.filter((candidate) => !refs.some((ref) => ref.locator === candidate.locator && ref.action === candidate.action)));
  const text = shellxDeepVisibleText(20000).trim();
  const title = document.title || location.href || "Untitled browser page";
  const traversal = shellxOpenDom();
  const domSummary = {
    links: shellxDeepQueryCount("a[href]"),
    buttons: shellxDeepQueryCount("button,input[type='button'],input[type='submit'],input[type='reset'],[role='button']"),
    inputs: shellxDeepQueryCount("input,textarea,select,[contenteditable='true']"),
    forms: shellxDeepQueryCount("form"),
    tables: shellxDeepQueryCount("table"),
    headings: shellxDeepQueryCount("h1,h2,h3,h4,h5,h6,[role='heading']"),
    textBytes: byteLength(text),
    sameOriginFrames: traversal.sameOriginFrames,
    crossOriginFrames: traversal.crossOriginFrames,
    openShadowRoots: traversal.openShadowRoots,
    traversalTruncated: traversal.traversalTruncated
  };
  const formControlRecords = shellxDeepQueryAll("input,textarea,select,[contenteditable='true']", 200).map((element, index) => {
    const selector = primarySelectorFor(element);
    if (!selector) return null;
    const locator = shellxDomLocatorFor(element);
    const ref = refs.find((item) => item.locator === locator);
    const field = {
      refId: ref?.refId || null,
      selector,
      label: labelFor(element) || fieldKindFor(element),
      fieldKind: fieldKindFor(element),
      value: valueFor(element),
      required: Boolean(element.required || element.getAttribute("aria-required") === "true"),
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      autocomplete: element.getAttribute("autocomplete") || null,
      formAction: element.form?.action || null,
      intent: fieldIntentFor(element),
      sensitive: isSensitiveField(element)
    };
    return { element, field, formKey: formKeyFor(element, index) };
  }).filter(Boolean);
  const formFields = formControlRecords.map((record) => ({
    refId: record.field.refId,
    selector: record.field.selector,
    label: record.field.label,
    fieldKind: record.field.fieldKind,
    value: record.field.value,
    required: record.field.required,
    disabled: record.field.disabled,
    autocomplete: record.field.autocomplete,
    formAction: record.field.formAction
  }));
  const formFieldGroups = Array.from(formControlRecords.reduce((groups, record) => {
    const key = record.formKey || "page";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record.field);
    return groups;
  }, new Map()).entries()).slice(0, 80).map(([key, fields], index) => {
    const fieldIntents = Array.from(new Set(fields.map((field) => field.intent).filter((intent) => intent && intent !== "generic")));
    const groupKind = groupKindFor(fields);
    return {
      groupId: `form-group-${index + 1}`,
      groupKind,
      label: formFieldGroupLabel(groupKind),
      formAction: fields.find((field) => field.formAction)?.formAction || null,
      fieldIntents,
      fields: fields.slice(0, 40).map((field) => ({
        refId: field.refId,
        selector: field.selector,
        label: field.label,
        fieldKind: field.fieldKind,
        intent: field.intent,
        required: field.required,
        disabled: field.disabled,
        sensitive: field.sensitive
      })),
      sensitive: fields.some((field) => field.sensitive)
    };
  });
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
    formFieldGroups,
    accessibilityTree,
    privacyStats: window.__shellxPrivacyStats || null
  };
})()
"#;

pub(crate) const BROWSER_ENGINE_CONTROL_SCRIPT: &str = r#"
(() => {
  const request = __SHELLX_BROWSER_REQUEST__;
  __SHELLX_ELEMENT_IDENTITY__
  __SHELLX_DOM_TRAVERSAL__
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
  const target = () => {
    if (request.locator) return shellxResolveDomLocator(request.locator);
    if (!request.selector) return { element: null, strictMatchCount: 0 };
    const matches = shellxRootSelectorMatches(document, request.selector);
    return { element: matches[0] || null, strictMatchCount: matches.length };
  };
  const dispatchTextEvents = (element, value, inputType = "insertText") => {
    const view = shellxElementWindow(element);
    try {
      element.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType, data: value }));
    } catch (_) {
      element.dispatchEvent(new view.Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new view.Event("change", { bubbles: true }));
  };
  const dispatchBeforeTextInput = (element, value, inputType = "insertText") => {
    const view = shellxElementWindow(element);
    try {
      return element.dispatchEvent(new view.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data: value }));
    } catch (_) {
      return element.dispatchEvent(new view.Event("beforeinput", { bubbles: true, cancelable: true }));
    }
  };
  const setNativeValue = (element, value) => {
    const tag = (element.localName || "").toLowerCase();
    const view = shellxElementWindow(element);
    const prototype = tag === "textarea" ? view.HTMLTextAreaElement?.prototype : view.HTMLInputElement?.prototype;
    const setter = prototype && Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) {
      setter.call(element, value);
    } else {
      element.value = value;
    }
  };
  const replaceContentEditableText = (element, value) => {
    const ownerDocument = element.ownerDocument || document;
    const view = ownerDocument.defaultView || window;
    element.focus?.();
    if (dispatchBeforeTextInput(element, value) === false) return false;
    try {
      const selection = view.getSelection?.();
      const range = ownerDocument.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } catch (_) {}
    let inserted = false;
    try {
      inserted = ownerDocument.execCommand("insertText", false, value);
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
      const view = shellxElementWindow(element);
      if (!view.__shellxTaintedControls) view.__shellxTaintedControls = new WeakSet();
      view.__shellxTaintedControls.add(element);
    } catch (_) {}
  };
  const visibleText = () => shellxDeepVisibleText(20000);
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
    const rect = shellxGlobalRectFor(element);
    return {
      x: Math.round(rect.x * 100) / 100,
      y: Math.round(rect.y * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100
    };
  };
  const selectorFor = shellxLocalSelectorFor;
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
      const root = shellxElementQueryRoot(element);
      const value = labelledBy
        .split(/\s+/)
        .map((id) => shellxRootById(root, id)?.innerText || shellxRootById(root, id)?.textContent || "")
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
  __SHELLX_COORDINATE_INPUT__
  __SHELLX_ELEMENT_ACTIONABILITY__
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
      const table = info.element?.matches?.("table") ? info.element : (info.element?.querySelector?.("table") || shellxDeepQueryAll("table", 1)[0]);
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
    const view = shellxElementWindow(element);
    if (!element || !(element instanceof view.HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = view.getComputedStyle(element);
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
    if (matchCount > 0) {
      const selectors = "h1,h2,h3,h4,p,li,td,th,a,button,label,summary,output,[aria-live],span,div,article,section,[role='button'],[role='link'],[role='status']";
      const elements = shellxDeepQueryAll(selectors, 5000);
      const first = elements.find((element) => {
        if (!isVisibleTextElement(element)) return false;
        const text = String(element.innerText || element.textContent || "");
        return (caseSensitive ? text : text.toLocaleLowerCase()).includes(needle);
      });
      if (first) {
        shellxScrollElementIntoView(first);
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
  try { if (request.expectedOrigin && !shellxPageOriginMatches(request.expectedOrigin)) return result(false, "originChanged", "page origin changed before Browser action");
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
      if (actionability.fingerprintMatches === false) return staleRefResult(actionability);
      if (element) {
        shellxScrollElementIntoView(element);
      } else {
        const delta = Number(request.value || 600);
        window.scrollBy(0, Number.isFinite(delta) ? delta : 600);
      }
      return result(true, "applied", "scroll applied", { actionability });
    }
    if (request.action === "waitFor") {
      const { element, strictMatchCount } = target();
      const needle = String(request.value || "");
      const actionability = actionabilityFor(element, request.selector, strictMatchCount, request.action);
      const staleRef = actionability.fingerprintMatches === false;
      const selectorWait = Boolean(request.selector), found = !staleRef && (selectorWait ? Boolean(element && actionability.visible && actionability.stable) : Boolean(needle && visibleText().includes(needle)));
      if (staleRef) return staleRefResult(actionability);
      return result(found, found ? "applied" : "notFound", found ? "waitFor matched" : selectorWait && element && !actionability.stable ? "waitFor target is not stable" : "waitFor target not found", selectorWait ? { actionability } : {});
    }
    if (request.action === "extractTable") {
      const { element, strictMatchCount } = target();
      const targetActionability = actionabilityFor(element, request.selector, strictMatchCount, request.action);
      if (targetActionability.fingerprintMatches === false) return staleRefResult(targetActionability);
      const table = element?.matches?.("table") ? element : (element?.querySelector?.("table") || shellxDeepQueryAll("table", 1)[0]);
      if (!table) return result(false, "notFound", "table not found");
      const actionability = actionabilityFor(table, request.selector, strictMatchCount || 1, request.action, null);
      if (targetActionability.expectedFingerprint) {
        actionability.expectedFingerprint = targetActionability.expectedFingerprint;
        actionability.actualFingerprint = targetActionability.actualFingerprint;
        actionability.fingerprintMatches = targetActionability.fingerprintMatches;
      }
      const rows = Array.from(table.querySelectorAll("tr")).slice(0, 200).map((row) =>
        Array.from(row.querySelectorAll("th,td")).slice(0, 50).map((cell) => String(cell.innerText || cell.textContent || "").trim())
      );
      return result(true, "applied", "table extracted", { actionability, extractedText: JSON.stringify(rows) });
    }
    if (request.action === "verify") {
      if (request.expectedFingerprint) {
        const { element, strictMatchCount } = target();
        const verifyActionability = actionabilityFor(element, request.selector, strictMatchCount, request.action);
        if (verifyActionability.fingerprintMatches === false) return staleRefResult(verifyActionability);
      }
      const verification = verifyExpectation();
      return result(verification.passed, verification.passed ? "applied" : "failed", verification.passed ? "verification passed" : "verification failed", { verification });
    }
    if (request.action === "findText") {
      const findResult = findTextOnPage();
      const found = findResult.matchCount > 0;
      return result(found, found ? "applied" : "notFound", found ? "text found" : "text not found", { findResult });
    }
    if (request.action === "clickAt" || request.action === "typeText") {
      return applyShellxCoordinateAction();
    }
    const { element, strictMatchCount } = target();
    if (!element) return result(false, "notFound", "target selector not found");
    shellxScrollElementIntoView(element);
    const actionability = actionabilityFor(element, request.selector, strictMatchCount, request.action);
    if (actionability.failedChecks.length > 0) {
      const forceClick = Boolean(request.force) && (request.action === "click" || request.action === "clickRef") && actionability.failedChecks.every((check) => check === "receivesEvents");
      if (!forceClick) {
        if (actionability.failedChecks.includes("fingerprint")) return staleRefResult(actionability);
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
        return result(true, "operatorClipboardRequired", "copy-only secret controls require an explicit operator clipboard transfer", { actionability });
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
      const view = shellxElementWindow(element);
      element.focus?.();
      element.dispatchEvent(new view.KeyboardEvent("keydown", { key, bubbles: true }));
      element.dispatchEvent(new view.KeyboardEvent("keyup", { key, bubbles: true }));
      return result(true, "applied", `key ${key} dispatched`, { actionability });
    }
    return result(false, "unsupported", `unsupported action ${request.action}`);
  } catch (error) {
    return result(false, "error", error instanceof Error ? error.message : String(error));
  }
})()
"#;

#[cfg(test)]
#[path = "shellx_browser_scripts_tests.rs"]
mod tests;
