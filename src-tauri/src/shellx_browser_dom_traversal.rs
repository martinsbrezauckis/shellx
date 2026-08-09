pub(crate) const BROWSER_DOM_TRAVERSAL_SCRIPT: &str = r#"
  const SHELLX_DOM_MAX_ROOTS = 32;
  const SHELLX_DOM_MAX_NODES = 12000;
  const SHELLX_DOM_MAX_NODES_PER_ROOT = 4000;
  const SHELLX_DOM_MAX_FRAME_DEPTH = 4;
  const SHELLX_DOM_MAX_SHADOW_DEPTH = 8;
  const shellxDomEscapeCss = (value) => {
    const css = globalThis.CSS;
    if (css && typeof css.escape === "function") return css.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };
  const shellxDomEscapeAttr = (value) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const shellxElementQueryRoot = (element) => {
    const root = element?.getRootNode?.();
    return root && typeof root.querySelectorAll === "function" ? root : element?.ownerDocument || document;
  };
  const shellxRootQueryAll = (root, selector, max = 1000) => {
    if (!root || !selector || typeof root.querySelectorAll !== "function") return [];
    try { return Array.from(root.querySelectorAll(selector)).slice(0, max); } catch (_) { return []; }
  };
  const shellxRootQueryCount = (root, selector, max = 1001) => shellxRootQueryAll(root, selector, max).length;
  const shellxRootById = (root, id) => {
    if (!root || !id) return null;
    if (typeof root.getElementById === "function") return root.getElementById(id);
    try { return root.querySelector(`#${shellxDomEscapeCss(id)}`); } catch (_) { return null; }
  };
  const shellxLocalSelectorFor = (element, root = shellxElementQueryRoot(element)) => {
    if (!element?.localName || !root) return "";
    const unique = (selector) => selector && shellxRootQueryCount(root, selector, 2) === 1 ? selector : "";
    const tag = element.localName.toLowerCase();
    if (element.id) {
      const byId = unique(`#${shellxDomEscapeCss(element.id)}`);
      if (byId) return byId;
    }
    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test-id");
    if (testId) {
      const escaped = shellxDomEscapeAttr(testId);
      const byTestId = unique(`${tag}[data-testid="${escaped}"]`) || unique(`[data-testid="${escaped}"]`);
      if (byTestId) return byTestId;
    }
    for (const name of ["name", "aria-label", "placeholder"]) {
      const value = element.getAttribute(name);
      if (!value) continue;
      const candidate = unique(`${tag}[${name}="${shellxDomEscapeAttr(value)}"]`);
      if (candidate) return candidate;
    }
    const parts = [];
    let current = element;
    while (current?.nodeType === 1 && parts.length < 8) {
      let part = current.localName.toLowerCase();
      const parent = current.parentElement;
      const siblingContainer = parent || (current.parentNode === root ? root : null);
      if (siblingContainer) {
        const same = Array.from(siblingContainer.children || []).filter((child) => child.localName === current.localName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      const candidate = parts.join(" > ");
      if (unique(candidate)) return candidate;
      if (!parent || parent === root) break;
      current = parent;
    }
    return parts.join(" > ");
  };
  const shellxLooksLikeXpath = (selector) => /^(\.?\/\/|\/)/.test(String(selector || "").trim());
  const shellxRootXpathMatches = (root, selector) => {
    if (!selector || !root || root.nodeType !== 9) return [];
    try {
      const view = root.defaultView || window;
      const snapshot = root.evaluate(selector, root, null, view.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const matches = [];
      for (let index = 0; index < Math.min(snapshot.snapshotLength, 1001); index += 1) {
        const item = snapshot.snapshotItem(index);
        if (item?.nodeType === 1) matches.push(item);
      }
      return matches;
    } catch (_) { return []; }
  };
  const shellxRootSelectorMatches = (root, selector) => shellxLooksLikeXpath(selector)
    ? shellxRootXpathMatches(root, selector)
    : shellxRootQueryAll(root, selector, 1001);
  const shellxLocalXpathFor = (element) => {
    const root = shellxElementQueryRoot(element);
    if (!element?.localName || root?.nodeType !== 9) return "";
    if (element.id) return `//*[@id="${String(element.id).replace(/"/g, '\\"')}"]`;
    const parts = [];
    let current = element;
    while (current?.nodeType === 1 && current !== root && parts.length < 16) {
      const tag = current.localName.toLowerCase();
      const parent = current.parentElement;
      const same = parent ? Array.from(parent.children).filter((child) => child.localName === current.localName) : [];
      parts.unshift(`${tag}${same.length > 1 ? `[${same.indexOf(current) + 1}]` : ""}`);
      current = parent;
    }
    return parts.length ? `/${parts.join("/")}` : "";
  };
  const shellxPrimarySelectorFor = (element) => shellxLocalSelectorFor(element) || shellxLocalXpathFor(element);
  const shellxFrameDocument = (frame) => {
    try {
      const frameDocument = frame?.contentDocument;
      if (!frameDocument?.documentElement) return null;
      const href = String(frameDocument.location?.href || "");
      if (href === "about:blank" || href === "about:srcdoc") return frameDocument;
      const frameOrigin = new URL(href, location.href).origin;
      return frameOrigin === location.origin ? frameDocument : null;
    } catch (_) { return null; }
  };
  const shellxDomLocatorFor = (element) => {
    if (!element?.localName) return null;
    const selector = shellxPrimarySelectorFor(element);
    if (!selector) return null;
    const steps = [];
    let current = element;
    let depth = 0;
    while (current && depth < SHELLX_DOM_MAX_FRAME_DEPTH + SHELLX_DOM_MAX_SHADOW_DEPTH) {
      const root = current.getRootNode?.();
      if (root?.host) {
        const host = root.host;
        const hostSelector = shellxPrimarySelectorFor(host);
        if (!hostSelector) return null;
        steps.unshift({ kind: "shadow", selector: hostSelector });
        current = host;
      } else if (root?.nodeType === 9) {
        let frame = null;
        try { frame = root.defaultView?.frameElement || null; } catch (_) { frame = null; }
        if (!frame) break;
        const frameSelector = shellxPrimarySelectorFor(frame);
        if (!frameSelector) return null;
        steps.unshift({ kind: "frame", selector: frameSelector });
        current = frame;
      } else {
        break;
      }
      depth += 1;
    }
    return JSON.stringify({ version: 1, steps: steps.slice(0, 12), selector });
  };
  const shellxResolveDomLocator = (rawLocator) => {
    if (!rawLocator || String(rawLocator).length > 4096) return { element: null, strictMatchCount: 0 };
    try {
      const locator = JSON.parse(String(rawLocator));
      if (locator?.version !== 1 || !Array.isArray(locator.steps) || locator.steps.length > 12) {
        return { element: null, strictMatchCount: 0 };
      }
      let root = document;
      for (const step of locator.steps) {
        const selector = String(step?.selector || "");
        if (!selector || selector.length > 512) return { element: null, strictMatchCount: 0 };
        const matches = shellxRootSelectorMatches(root, selector);
        if (matches.length !== 1) return { element: null, strictMatchCount: matches.length };
        if (step.kind === "shadow") {
          root = matches[0].shadowRoot;
        } else if (step.kind === "frame") {
          root = shellxFrameDocument(matches[0]);
        } else {
          return { element: null, strictMatchCount: 0 };
        }
        if (!root) return { element: null, strictMatchCount: 0 };
      }
      const matches = shellxRootSelectorMatches(root, String(locator.selector || ""));
      return { element: matches[0] || null, strictMatchCount: matches.length };
    } catch (_) { return { element: null, strictMatchCount: 0 }; }
  };
  const shellxElementFrameDepth = (element) => {
    let documentCursor = element?.ownerDocument;
    let depth = 0;
    while (documentCursor && depth < SHELLX_DOM_MAX_FRAME_DEPTH) {
      let frame = null;
      try { frame = documentCursor.defaultView?.frameElement || null; } catch (_) { frame = null; }
      if (!frame) break;
      depth += 1;
      documentCursor = frame.ownerDocument;
    }
    return depth;
  };
  const shellxElementFrameUrl = (element) => {
    try { return String(element?.ownerDocument?.location?.href || location.href); } catch (_) { return location.href; }
  };
  const shellxElementFrameId = (element) => {
    if (shellxElementFrameDepth(element) === 0) return "main";
    const locator = shellxDomLocatorFor(element) || "frame";
    let hash = 0x811c9dc5;
    for (let index = 0; index < locator.length; index += 1) hash = Math.imul((hash ^ locator.charCodeAt(index)) >>> 0, 0x01000193) >>> 0;
    return `frame-${hash.toString(16).padStart(8, "0")}`;
  };
  const shellxElementWindow = (element) => element?.ownerDocument?.defaultView || window;
  const shellxLocalRectFor = (element) => element?.getBoundingClientRect?.() || null;
  const shellxGlobalRectFor = (element) => {
    const local = shellxLocalRectFor(element);
    if (!local) return null;
    let left = local.left, top = local.top, width = local.width, height = local.height;
    let documentCursor = element.ownerDocument;
    for (let depth = 0; documentCursor && depth < SHELLX_DOM_MAX_FRAME_DEPTH; depth += 1) {
      let frame = null;
      try { frame = documentCursor.defaultView?.frameElement || null; } catch (_) { frame = null; }
      if (!frame) break;
      const frameRect = frame.getBoundingClientRect();
      const scaleX = frame.clientWidth > 0 ? frameRect.width / frame.clientWidth : 1;
      const scaleY = frame.clientHeight > 0 ? frameRect.height / frame.clientHeight : 1;
      left = frameRect.left + frame.clientLeft + left * scaleX;
      top = frameRect.top + frame.clientTop + top * scaleY;
      width *= scaleX;
      height *= scaleY;
      documentCursor = frame.ownerDocument;
    }
    return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height };
  };
  const shellxScrollElementIntoView = (element) => {
    element?.scrollIntoView?.({ block: "center", inline: "center", behavior: "instant" });
    let documentCursor = element?.ownerDocument;
    for (let depth = 0; documentCursor && depth < SHELLX_DOM_MAX_FRAME_DEPTH; depth += 1) {
      let frame = null;
      try { frame = documentCursor.defaultView?.frameElement || null; } catch (_) { frame = null; }
      if (!frame) break;
      frame.scrollIntoView?.({ block: "center", inline: "center", behavior: "instant" });
      documentCursor = frame.ownerDocument;
    }
  };
  const shellxCollectOpenDom = () => {
    const contexts = [];
    const queue = [{ root: document, frameDepth: 0, shadowDepth: 0 }];
    const visited = new WeakSet();
    let nodesScanned = 0, sameOriginFrames = 0, crossOriginFrames = 0, openShadowRoots = 0, traversalTruncated = false;
    while (queue.length > 0 && contexts.length < SHELLX_DOM_MAX_ROOTS) {
      const context = queue.shift();
      if (!context?.root || visited.has(context.root)) continue;
      visited.add(context.root);
      const elements = [];
      const frameElements = shellxRootQueryAll(context.root, "iframe,frame", 64);
      for (const frame of frameElements) {
        if (context.frameDepth >= SHELLX_DOM_MAX_FRAME_DEPTH) { traversalTruncated = true; continue; }
        const frameDocument = shellxFrameDocument(frame);
        if (frameDocument) {
          sameOriginFrames += 1;
          queue.push({ root: frameDocument, frameDepth: context.frameDepth + 1, shadowDepth: context.shadowDepth });
        } else {
          crossOriginFrames += 1;
        }
      }
      const ownerDocument = context.root.nodeType === 9 ? context.root : context.root.ownerDocument;
      const walker = ownerDocument?.createTreeWalker?.(context.root, 1);
      while (walker && elements.length < SHELLX_DOM_MAX_NODES_PER_ROOT && nodesScanned < SHELLX_DOM_MAX_NODES) {
        const element = walker.nextNode();
        if (!element) break;
        elements.push(element);
        nodesScanned += 1;
        if (element.shadowRoot) {
          if (context.shadowDepth >= SHELLX_DOM_MAX_SHADOW_DEPTH) {
            traversalTruncated = true;
          } else {
            openShadowRoots += 1;
            queue.push({ root: element.shadowRoot, frameDepth: context.frameDepth, shadowDepth: context.shadowDepth + 1 });
          }
        }
      }
      if (elements.length >= SHELLX_DOM_MAX_NODES_PER_ROOT || nodesScanned >= SHELLX_DOM_MAX_NODES) traversalTruncated = true;
      contexts.push({ ...context, elements });
    }
    if (queue.length > 0) traversalTruncated = true;
    return { contexts, nodesScanned, sameOriginFrames, crossOriginFrames, openShadowRoots, traversalTruncated };
  };
  let shellxOpenDomCache = null;
  const shellxOpenDom = () => shellxOpenDomCache || (shellxOpenDomCache = shellxCollectOpenDom());
  const shellxDeepQueryAll = (selector, max = 1000) => {
    const matches = [];
    for (const context of shellxOpenDom().contexts) {
      for (const element of context.elements) {
        try { if (element.matches(selector)) matches.push(element); } catch (_) {}
        if (matches.length >= max) return matches;
      }
    }
    return matches;
  };
  const shellxDeepQueryCount = (selector, max = 1001) => shellxDeepQueryAll(selector, max).length;
  const shellxDeepVisibleText = (max = 20000) => {
    const parts = [];
    let length = 0;
    for (const context of shellxOpenDom().contexts) {
      const root = context.root;
      const text = String(root.nodeType === 9 ? (root.body?.innerText || root.documentElement?.innerText || "") : (root.textContent || "")).trim();
      if (!text) continue;
      const remaining = Math.max(0, max - length);
      if (remaining === 0) break;
      parts.push(text.slice(0, remaining));
      length += Math.min(text.length, remaining);
    }
    return parts.join("\n").slice(0, max);
  };
"#;

#[cfg(test)]
mod tests {
    use super::BROWSER_DOM_TRAVERSAL_SCRIPT;

    #[test]
    fn traversal_is_bounded_and_same_origin_only() {
        assert!(BROWSER_DOM_TRAVERSAL_SCRIPT.contains("SHELLX_DOM_MAX_NODES = 12000"));
        assert!(BROWSER_DOM_TRAVERSAL_SCRIPT.contains("frameOrigin === location.origin"));
        assert!(BROWSER_DOM_TRAVERSAL_SCRIPT.contains("element.shadowRoot"));
        assert!(BROWSER_DOM_TRAVERSAL_SCRIPT.contains("current.parentNode === root"));
        assert!(BROWSER_DOM_TRAVERSAL_SCRIPT.contains("shellxResolveDomLocator"));
    }
}
