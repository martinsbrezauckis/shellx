pub(crate) const BROWSER_COORDINATE_INPUT_SCRIPT: &str = r#"
  const insertTextAtSelection = (element, value) => {
    element.focus?.();
    if (dispatchBeforeTextInput(element, value) === false) return false;
    if (element.isContentEditable) {
      const ownerDocument = element.ownerDocument || document;
      let inserted = false;
      try {
        inserted = ownerDocument.execCommand("insertText", false, value);
      } catch (_) {
        inserted = false;
      }
      if (!inserted) element.textContent = `${element.textContent || ""}${value}`;
    } else if ("value" in element) {
      const current = String(element.value || "");
      const start = Number.isInteger(element.selectionStart) ? element.selectionStart : current.length;
      const end = Number.isInteger(element.selectionEnd) ? element.selectionEnd : start;
      if (typeof element.setRangeText === "function") {
        element.setRangeText(value, start, end, "end");
      } else {
        setNativeValue(element, `${current.slice(0, start)}${value}${current.slice(end)}`);
      }
    } else {
      return false;
    }
    dispatchTextEvents(element, value);
    return true;
  };
  const coordinateActionability = (action) => {
    const x = Number(request.x);
    const y = Number(request.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: "viewport coordinates x and y are required" };
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      return { error: "viewport coordinates are outside the visible page" };
    }
    const element = document.elementFromPoint(x, y);
    const selector = selectorFor(element) || null;
    const editable = action !== "typeText" || isEditable(element);
    const failedChecks = [];
    if (!element) failedChecks.push("attached");
    if (element && !editable) failedChecks.push("editable");
    return { actionability: {
      attached: Boolean(element), visible: true, stable: true, enabled: true, editable,
      inViewport: true, receivesEvents: true, strictMatchCount: 1, selector,
      bounds: { x, y, width: 1, height: 1 },
      coveringElement: element ? {
        selector, role: roleFor(element) || null, label: labelFor(element) || null,
        bounds: boundsFor(element)
      } : null,
      failedChecks
    } };
  };
  const applyShellxCoordinateAction = () => {
    const coordinate = coordinateActionability(request.action);
    if (coordinate.error) return result(false, "invalid", coordinate.error);
    if (coordinate.actionability.failedChecks.length > 0) {
      return result(false, "notActionable", "viewport coordinate did not resolve to an actionable page element", { actionability: coordinate.actionability });
    }
    if (__SHELLX_NATIVE_COORDINATE_INPUT__) {
      return result(true, "applied", request.action === "typeText" ? "viewport text target prepared" : "viewport click target prepared", {
        actionability: coordinate.actionability, nativeInputRecommended: true
      });
    }
    const element = document.elementFromPoint(Number(request.x), Number(request.y));
    if (request.action === "clickAt") {
      ensureShellxPermissionReporter();
      element.click();
      return result(true, "applied", "viewport click applied through page fallback", {
        actionability: coordinate.actionability, nativeInputRecommended: false
      });
    }
    const value = String(request.value || "");
    if (!insertTextAtSelection(element, value)) {
      return result(false, "blocked", "viewport text input was cancelled by the page", { actionability: coordinate.actionability });
    }
    return result(true, "applied", "viewport text inserted through page fallback", {
      actionability: coordinate.actionability, nativeInputRecommended: false
    });
  };
"#;
