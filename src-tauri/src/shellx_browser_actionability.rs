pub(crate) const BROWSER_ELEMENT_ACTIONABILITY_SCRIPT: &str = r#"
  const SHELLX_ELEMENT_STABILITY_MIN_MS = 120;
  const SHELLX_UNKNOWN_ANIMATION_GRACE_MS = 500;
  const shellxAnimationTimeMs = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value && typeof value.value === "number" && Number.isFinite(value.value)) return value.value;
    const parsed = Number.parseFloat(String(value ?? ""));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const shellxPageOriginMatches = (expectedOrigin) =>
    typeof expectedOrigin === "string" && location.origin === expectedOrigin;
  const shellxAnimationIsVisuallyActive = (animation) => {
    if (!["pending", "running"].includes(animation?.playState)) return false;
    const computed = animation.effect?.getComputedTiming?.();
    const currentTime = shellxAnimationTimeMs(animation.currentTime);
    const endTime = shellxAnimationTimeMs(computed?.endTime);
    if (currentTime !== null && endTime !== null && currentTime >= endTime) return false;
    const progress = Number(computed?.progress);
    if (Number.isFinite(progress) && progress >= 1) return false;
    return true;
  };
  const shellxRunningGeometryAnimations = (element) => {
    if (!element || typeof element.getAnimations !== "function") return { count: 0, graceMs: 0 };
    const geometryProperties = [
      "transform", "translate", "scale", "rotate", "left", "top", "right", "bottom",
      "width", "height", "margin", "padding", "fontSize", "borderWidth"
    ];
    const animations = element.getAnimations().filter((animation) => {
      if (!shellxAnimationIsVisuallyActive(animation)) return false;
      const iterations = Number(animation.effect?.getTiming?.().iterations ?? 1);
      if (!Number.isFinite(iterations)) return false;
      const frames = animation.effect?.getKeyframes?.();
      if (!Array.isArray(frames) || frames.length === 0) return true;
      return frames.some((frame) => geometryProperties.some(
        (property) => Object.prototype.hasOwnProperty.call(frame, property)
      ));
    });
    const graceMs = animations.reduce((maximum, animation) => {
      const timing = animation.effect?.getTiming?.() ?? {};
      const duration = shellxAnimationTimeMs(timing.duration);
      const delay = shellxAnimationTimeMs(timing.delay) ?? 0;
      const endDelay = shellxAnimationTimeMs(timing.endDelay) ?? 0;
      const iterations = Number(timing.iterations ?? 1);
      const total = duration !== null && Number.isFinite(iterations)
        ? Math.max(0, delay) + Math.max(0, duration * iterations) + Math.max(0, endDelay)
        : SHELLX_UNKNOWN_ANIMATION_GRACE_MS;
      return Math.max(maximum, Math.min(5000, total));
    }, 0);
    return { count: animations.length, graceMs };
  };
  const shellxElementStability = (element, rect, animationState) => {
    if (!element) return { stable: false, stabilityMs: 0, stabilitySamples: 0 };
    let store = window.__shellxElementStabilityV1;
    if (!(store instanceof WeakMap)) {
      store = new WeakMap();
      try {
        Object.defineProperty(window, "__shellxElementStabilityV1", {
          value: store,
          writable: false,
          configurable: false
        });
      } catch (_) {
        window.__shellxElementStabilityV1 = store;
      }
    }
    const now = performance.now();
    const geometry = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    const previous = store.get(element);
    const animationActiveSince = animationState.count > 0
      ? (Number.isFinite(previous?.animationActiveSince) ? previous.animationActiveSince : now)
      : null;
    const animationBlocks = animationState.count > 0
      && now - animationActiveSince < Math.max(animationState.graceMs, 0);
    const unchanged = !animationBlocks && Boolean(previous && ["left", "top", "width", "height"].every(
      (key) => Math.abs(previous.geometry[key] - geometry[key]) <= 0.5
    ));
    const stableSince = unchanged && Number.isFinite(previous.stableSince) ? previous.stableSince : now;
    const previousSamples = unchanged && Number.isFinite(previous.stabilitySamples) ? previous.stabilitySamples : 0;
    const stabilitySamples = unchanged ? previousSamples + 1 : 1;
    const stabilityMs = unchanged ? Math.max(0, now - stableSince) : 0;
    store.set(element, { geometry, stableSince, stabilitySamples, animationActiveSince });
    return {
      stable: unchanged && stabilitySamples >= 2 && stabilityMs >= SHELLX_ELEMENT_STABILITY_MIN_MS,
      stabilityMs: Math.floor(stabilityMs),
      stabilitySamples
    };
  };
  const shellxElementIsAttached = (element) => {
    if (!element?.isConnected || !element.ownerDocument) return false;
    let documentCursor = element.ownerDocument;
    for (let depth = 0; documentCursor && depth <= SHELLX_DOM_MAX_FRAME_DEPTH; depth += 1) {
      let frame = null;
      try { frame = documentCursor.defaultView?.frameElement || null; } catch (_) { frame = null; }
      if (!frame) return documentCursor === document;
      if (!frame.isConnected) return false;
      documentCursor = frame.ownerDocument;
    }
    return false;
  };
  const shellxComposedContains = (container, node) => {
    let current = node;
    for (let depth = 0; current && depth < 16; depth += 1) {
      if (current === container || container?.contains?.(current)) return true;
      const root = current.getRootNode?.();
      current = root?.host || null;
    }
    return false;
  };
  const shellxDeepElementFromPoint = (ownerDocument, x, y) => {
    let hit = ownerDocument?.elementFromPoint?.(x, y) || null;
    for (let depth = 0; hit?.shadowRoot && depth < SHELLX_DOM_MAX_SHADOW_DEPTH; depth += 1) {
      const nested = hit.shadowRoot.elementFromPoint?.(x, y) || null;
      if (!nested || nested === hit) break;
      hit = nested;
    }
    return hit;
  };
  const actionabilityFor = (element, selector, strictMatchCount, action, expectedFingerprint = request.expectedFingerprint) => {
    const attached = shellxElementIsAttached(element);
    const emptyRect = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
    const localRect = attached ? shellxLocalRectFor(element) : emptyRect;
    const globalRect = attached ? shellxGlobalRectFor(element) : emptyRect;
    const ownerWindow = attached ? shellxElementWindow(element) : window;
    const ownerDocument = attached ? element.ownerDocument : document;
    const style = attached ? ownerWindow.getComputedStyle(element) : null;
    const visible = Boolean(attached && localRect.width > 0 && localRect.height > 0 && style?.display !== "none" && style?.visibility !== "hidden" && Number(style?.opacity || 1) > 0);
    const enabled = attached ? isEnabled(element) : false;
    const editable = attached ? isEditable(element) : false;
    const fingerprintCheck = shellxElementFingerprintCheck(attached ? element : null, expectedFingerprint);
    const runningGeometryAnimations = attached
      ? shellxRunningGeometryAnimations(element)
      : { count: 0, graceMs: 0 };
    const stability = visible && fingerprintCheck.fingerprintMatches !== false
      ? shellxElementStability(element, globalRect, runningGeometryAnimations)
      : { stable: false, stabilityMs: 0, stabilitySamples: 0 };
    const inLocalViewport = Boolean(visible && localRect.bottom >= 0 && localRect.right >= 0 && localRect.top <= ownerWindow.innerHeight && localRect.left <= ownerWindow.innerWidth);
    const inViewport = Boolean(inLocalViewport && globalRect.bottom >= 0 && globalRect.right >= 0 && globalRect.top <= window.innerHeight && globalRect.left <= window.innerWidth);
    let receivesEvents = false;
    let coveringElement = null;
    if (inViewport) {
      const x = Math.min(Math.max(localRect.left + localRect.width / 2, 0), Math.max(ownerWindow.innerWidth - 1, 0));
      const y = Math.min(Math.max(localRect.top + localRect.height / 2, 0), Math.max(ownerWindow.innerHeight - 1, 0));
      const hit = shellxDeepElementFromPoint(ownerDocument, x, y);
      receivesEvents = Boolean(hit && (shellxComposedContains(element, hit) || shellxComposedContains(hit, element)));
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
      stable: stability.stable,
      stabilityMs: stability.stabilityMs,
      stabilitySamples: stability.stabilitySamples,
      ...fingerprintCheck,
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
    const needsStable = ["waitFor", "click", "clickRef", "fillRef", "type", "select", "press", "capturePageSecretToVault"].includes(action);
    if (!attached) check.failedChecks.push("attached");
    if (fingerprintCheck.fingerprintMatches === false) check.failedChecks.push("fingerprint");
    if (strictMatchCount !== 1 && selector) check.failedChecks.push("strict");
    if (!visible && action !== "scroll") check.failedChecks.push("visible");
    if (needsStable && visible && !stability.stable) check.failedChecks.push("stable");
    if (!enabled && ["click", "clickRef", "fillRef", "type", "select", "press"].includes(action)) check.failedChecks.push("enabled");
    if (needsEditable && !editable) check.failedChecks.push("editable");
    if (!inViewport && action !== "scroll") check.failedChecks.push("inViewport");
    if (!receivesEvents && ["click", "clickRef"].includes(action)) check.failedChecks.push("receivesEvents");
    return check;
  };
  const staleRefResult = (actionability) => result(false, "staleRef", "observed target identity changed; re-observe before retrying", { actionability });
"#;
