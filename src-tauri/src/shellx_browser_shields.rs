use tauri::Url;

use crate::shellx_browser::{clean_string, now_ms, BrowserState};
use crate::shellx_browser_model::{
    BrowserAdMode, BrowserAdRuleDecision, BrowserPrivacySettings, BrowserPrivacyStats,
    BrowserShieldSettings, BrowserTabShieldState, BrowserTabSnapshot,
};
use crate::shellx_browser_security::browser_host_from_url;

pub(crate) const BROWSER_AD_MODE_VISUAL_CLEAN_COMPATIBILITY: &str = "visualCleanCompatibility";

pub(crate) fn normalize_shield_mode(raw: &str, allowed: &[&str], fallback: &str) -> String {
    let cleaned = clean_string(raw);
    if allowed.iter().any(|candidate| *candidate == cleaned) {
        cleaned
    } else {
        fallback.to_string()
    }
}

pub(crate) fn browser_tab_shields_for_url(
    shields: &BrowserShieldSettings,
    raw_url: Option<&str>,
) -> BrowserTabShieldState {
    let host = browser_host_from_url(raw_url);
    let site_override = host.as_ref().and_then(|host| {
        shields
            .site_overrides
            .iter()
            .find(|override_settings| &override_settings.host == host)
    });
    BrowserTabShieldState {
        host,
        enabled: shields.enabled,
        effective_ad_tracker_mode: site_override
            .map(|override_settings| override_settings.ad_tracker_mode.clone())
            .unwrap_or_else(|| shields.ad_tracker_mode.clone()),
        effective_cookie_mode: site_override
            .map(|override_settings| override_settings.cookie_mode.clone())
            .unwrap_or_else(|| shields.cookie_mode.clone()),
        effective_fingerprinting_mode: site_override
            .map(|override_settings| override_settings.fingerprinting_mode.clone())
            .unwrap_or_else(|| shields.fingerprinting_mode.clone()),
        https_upgrade_enabled: site_override
            .map(|override_settings| override_settings.https_upgrade_enabled)
            .unwrap_or(shields.https_upgrade_enabled),
        script_blocking_enabled: site_override
            .map(|override_settings| override_settings.script_blocking_enabled)
            .unwrap_or(shields.script_blocking_enabled),
        has_site_override: site_override.is_some(),
        blocked_ad_tracker_count: 0,
    }
}

fn browser_ad_mode_label(mode: &BrowserAdMode) -> &'static str {
    match mode {
        BrowserAdMode::Off => "off",
        BrowserAdMode::Balanced => "balanced",
        BrowserAdMode::Strict => "strict",
        BrowserAdMode::VisualCleanCompatibility => BROWSER_AD_MODE_VISUAL_CLEAN_COMPATIBILITY,
    }
}

pub(crate) fn apply_privacy_mode_to_tab_shields(
    shields: &mut BrowserTabShieldState,
    privacy_mode: &BrowserAdMode,
) {
    if !shields.enabled
        || shields.effective_ad_tracker_mode == "off"
        || *privacy_mode == BrowserAdMode::Off
    {
        shields.effective_ad_tracker_mode = "off".to_string();
        shields.blocked_ad_tracker_count = 0;
    } else if shields.effective_ad_tracker_mode == "strict"
        || *privacy_mode == BrowserAdMode::Strict
    {
        shields.effective_ad_tracker_mode = "strict".to_string();
    } else {
        shields.effective_ad_tracker_mode = browser_ad_mode_label(privacy_mode).to_string();
    }
}

fn browser_privacy_stats_count(stats: &BrowserPrivacyStats) -> u32 {
    stats
        .hidden_elements
        .saturating_add(stats.masked_elements)
        .saturating_add(stats.blocked_requests)
}

pub(crate) fn apply_privacy_stats_to_tab(
    tab: &mut BrowserTabSnapshot,
    stats: Option<&BrowserPrivacyStats>,
) {
    if let Some(stats) = stats {
        tab.shields.blocked_ad_tracker_count = browser_privacy_stats_count(stats);
        apply_privacy_mode_to_tab_shields(&mut tab.shields, &tab.privacy_mode);
    }
}

pub(crate) fn refresh_browser_tab_effective_shields_for_url(
    tab: &mut BrowserTabSnapshot,
    shields: &BrowserShieldSettings,
    raw_url: Option<&str>,
) {
    tab.shields = browser_tab_shields_for_url(shields, raw_url);
    apply_privacy_mode_to_tab_shields(&mut tab.shields, &tab.privacy_mode);
}

pub(crate) fn refresh_browser_tab_effective_shields(
    tab: &mut BrowserTabSnapshot,
    shields: &BrowserShieldSettings,
) {
    let url = tab.url.clone();
    refresh_browser_tab_effective_shields_for_url(tab, shields, url.as_deref());
}

pub(crate) fn refresh_browser_tab_shields(state: &mut BrowserState) {
    let shields = state.shields.clone();
    for tab in &mut state.tabs {
        refresh_browser_tab_effective_shields(tab, &shields);
    }
    refresh_browser_engine_privacy_modes(state);
}

pub(crate) fn refresh_browser_engine_privacy_modes(state: &mut BrowserState) {
    let privacy = state.privacy.clone();
    let shields = state.shields.clone();
    let tabs = state.tabs.clone();
    let mut compat_snapshot = None;
    for engine in &mut state.engine_pool.engines {
        let tab = engine
            .browser_tab_id
            .as_deref()
            .and_then(|tab_id| tabs.iter().find(|tab| tab.browser_tab_id == tab_id));
        let profile_id = tab
            .map(|tab| tab.profile_id.as_str())
            .or(engine.profile_id.as_deref())
            .unwrap_or("agent-work");
        let raw_url = tab
            .and_then(|tab| tab.url.as_deref())
            .or(engine.url.as_deref());
        engine.privacy_mode =
            effective_ad_mode_for_profile_and_url(&privacy, &shields, profile_id, raw_url);
        engine.updated_at_ms = now_ms();
        if state.engine.engine_id == engine.engine_id {
            compat_snapshot = Some(engine.clone());
        }
    }
    if let Some(snapshot) = compat_snapshot {
        state.engine = snapshot.clone();
        state.engine_waitlist = snapshot.waitlist;
    } else if state.engine.mounted || state.engine.profile_id.is_some() {
        let profile_id = state.engine.profile_id.as_deref().unwrap_or("agent-work");
        state.engine.privacy_mode = effective_ad_mode_for_profile_and_url(
            &privacy,
            &shields,
            profile_id,
            state.engine.url.as_deref(),
        );
        state.engine.updated_at_ms = now_ms();
    }
}

pub(crate) fn ad_mode_for_profile(
    privacy: &BrowserPrivacySettings,
    profile_id: &str,
) -> BrowserAdMode {
    privacy
        .profile_modes
        .iter()
        .find(|item| item.profile_id == profile_id)
        .map(|item| item.ad_mode.clone())
        .unwrap_or_else(|| privacy.global_ad_mode.clone())
}

pub(crate) fn effective_ad_mode_for_profile_and_url(
    privacy: &BrowserPrivacySettings,
    shields: &BrowserShieldSettings,
    profile_id: &str,
    raw_url: Option<&str>,
) -> BrowserAdMode {
    let privacy_mode = ad_mode_for_profile(privacy, profile_id);
    let tab_shields = browser_tab_shields_for_url(shields, raw_url);
    if !tab_shields.enabled
        || tab_shields.effective_ad_tracker_mode == "off"
        || privacy_mode == BrowserAdMode::Off
    {
        BrowserAdMode::Off
    } else if tab_shields.effective_ad_tracker_mode == "strict"
        || privacy_mode == BrowserAdMode::Strict
    {
        BrowserAdMode::Strict
    } else {
        privacy_mode
    }
}

pub fn browser_ad_decision_for_url(mode: &BrowserAdMode, url: &str) -> BrowserAdRuleDecision {
    let normalized = url.to_ascii_lowercase();
    let host = Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_ascii_lowercase()))
        .unwrap_or_default();
    let path = Url::parse(url)
        .ok()
        .map(|parsed| parsed.path().to_ascii_lowercase())
        .unwrap_or_else(|| normalized.clone());
    let matched = [
        (
            "host:doubleclick",
            "advertising",
            host.contains("doubleclick.net"),
        ),
        (
            "host:googletagservices",
            "advertising",
            host.contains("googletagservices.com"),
        ),
        (
            "host:pagead",
            "advertising",
            host.contains("pagead2.googlesyndication.com"),
        ),
        (
            "host:googlesyndication",
            "advertising",
            host.contains("googlesyndication.com"),
        ),
        (
            "host:google-analytics",
            "analytics",
            host.contains("google-analytics.com"),
        ),
        (
            "host:googletagmanager",
            "analytics",
            host.contains("googletagmanager.com"),
        ),
        (
            "host:adservice",
            "advertising",
            host.contains("adservice.google."),
        ),
        ("host:adform", "advertising", host.contains("adform.net")),
        ("host:gemius", "analytics", host.contains("gemius.")),
        (
            "host:meta-pixel",
            "analytics",
            host.contains("facebook.net"),
        ),
        (
            "host:scorecardresearch",
            "analytics",
            host.contains("scorecardresearch.com"),
        ),
        ("host:adnxs", "advertising", host.contains("adnxs.com")),
        ("host:criteo", "advertising", host.contains("criteo.com")),
        (
            "host:pubmatic",
            "advertising",
            host.contains("pubmatic.com"),
        ),
        (
            "host:rubiconproject",
            "advertising",
            host.contains("rubiconproject.com"),
        ),
        ("host:openx", "advertising", host.contains("openx.net")),
        (
            "path:ads",
            "advertising",
            path.contains("/ads/")
                || path.contains("/ad/")
                || path.contains("/adserver")
                || path.contains("/advert")
                || path.contains("banner"),
        ),
        (
            "path:tracker",
            "analytics",
            path.contains("tracker")
                || path.contains("tracking")
                || path.contains("analytics")
                || path.contains("/collect"),
        ),
    ]
    .into_iter()
    .find(|(_, _, matched)| *matched);
    let (rule_id, category) = matched
        .map(|(rule_id, category, _)| (Some(rule_id.to_string()), Some(category.to_string())))
        .unwrap_or((None, None));
    let matched = rule_id.is_some();
    BrowserAdRuleDecision {
        mode: mode.clone(),
        suppressed: matched && matches!(mode, BrowserAdMode::Balanced | BrowserAdMode::Strict),
        presentation_masked: matched && matches!(mode, BrowserAdMode::VisualCleanCompatibility),
        category,
        rule_id,
    }
}

pub(crate) fn browser_requires_native_request_filter(mode: &BrowserAdMode) -> bool {
    matches!(mode, BrowserAdMode::Strict)
}

pub(crate) fn browser_privacy_initialization_script(mode: &BrowserAdMode) -> String {
    let mode = serde_json::to_string(mode).unwrap_or_else(|_| "\"balanced\"".to_string());
    r#"
(() => {
  const mode = __SHELLX_PRIVACY_MODE__;
  window.__shellxPrivacyMode = mode;
  window.__shellxPrivacyGeneration = Number(window.__shellxPrivacyGeneration || 0) + 1;
  const privacyGeneration = window.__shellxPrivacyGeneration;

  const now = () => Math.max(0, Math.round(performance.now ? performance.now() : Date.now()));
  const ensureStats = () => {
    const previous = window.__shellxPrivacyStats || {};
    const stats = {
      mode,
      hiddenElements: Number(previous.hiddenElements || 0),
      maskedElements: Number(previous.maskedElements || 0),
      blockedRequests: Number(previous.blockedRequests || 0),
      matchedElements: Number(previous.matchedElements || 0),
      lastRunAt: now()
    };
    window.__shellxPrivacyStats = stats;
    return stats;
  };
  const resetPrivacyStatsForOffMode = () => {
    const current = ensureStats();
    current.hiddenElements = 0;
    current.maskedElements = 0;
    current.blockedRequests = 0;
    current.matchedElements = 0;
    current.lastRunAt = now();
    return current;
  };
  const stats = ensureStats();
  const snapshot = () => ({
    mode: window.__shellxPrivacyMode || mode,
    hiddenElements: Number(window.__shellxPrivacyStats?.hiddenElements || 0),
    maskedElements: Number(window.__shellxPrivacyStats?.maskedElements || 0),
    blockedRequests: Number(window.__shellxPrivacyStats?.blockedRequests || 0),
    matchedElements: Number(window.__shellxPrivacyStats?.matchedElements || 0),
    lastRunAt: Number(window.__shellxPrivacyStats?.lastRunAt || 0)
  });
  const activeMode = () => {
    const value = window.__shellxPrivacyMode || "off";
    return value === "balanced" || value === "strict" || value === "visualCleanCompatibility";
  };
  const hostMatches = (host, patterns) => patterns.some((pattern) => host === pattern || host.endsWith(`.${pattern}`));
  const adHosts = [
    "2mdn.net",
    "adform.net",
    "adnxs.com",
    "adsrvr.org",
    "adservice.google.com",
    "adservice.google.lv",
    "adservice.googleusercontent.com",
    "analytics.google.com",
    "clarity.ms",
    "criteo.com",
    "doubleclick.net",
    "facebook.net",
    "gemius.lv",
    "gemius.pl",
    "google-analytics.com",
    "googlesyndication.com",
    "googletagmanager.com",
    "googletagservices.com",
    "hotjar.com",
    "openx.net",
    "pagead2.googlesyndication.com",
    "pubmatic.com",
    "rubiconproject.com",
    "scorecardresearch.com"
  ];
  const adPathPatterns = [
    /\/ads?\//i,
    /\/adserver/i,
    /\/advert/i,
    /\/banner/i,
    /\/collect(?:\?|$)/i,
    /\/gampad\//i,
    /\/pagead\//i,
    /\/pixel(?:\?|$)/i,
    /\/tracking?\//i,
    /[?&](?:ad|ads|advert|gclid|fbclid)=/i
  ];
  const isAdUrl = (raw) => {
    if (!raw) return false;
    try {
      const url = new URL(String(raw), location.href);
      const host = url.hostname.toLowerCase();
      const path = `${url.pathname}${url.search}`.toLowerCase();
      if (hostMatches(host, adHosts)) return true;
      return adPathPatterns.some((pattern) => pattern.test(path));
    } catch (_) {
      const value = String(raw).toLowerCase();
      return /doubleclick|googlesyndication|googletagmanager|googletagservices|google-analytics|adform|gemius|scorecardresearch|facebook\.net|\/ads?\//.test(value);
    }
  };
  const markBlocked = () => {
    const current = ensureStats();
    current.blockedRequests += 1;
    current.lastRunAt = now();
  };
  const persistentPresentationSelectors = [
    ".adsbygoogle",
    "ins.adsbygoogle",
    "amp-ad",
    "amp-embed[type='doubleclick']",
    "iframe[src*='doubleclick']",
    "iframe[src*='googlesyndication']",
    "iframe[src*='googletagservices']",
    "iframe[src*='adform.net']",
    "iframe[src*='gemius']",
    ".monster-overlay",
    ".monster-container",
    ".monster-header",
    ".close-ad-button",
    ".ad-countdown"
  ];
  const syncPrivacyStylesheet = () => {
    const styleId = "__shellx_ad_filter_style";
    const existing = document.getElementById(styleId);
    if (!activeMode()) {
      existing?.remove?.();
      return;
    }
    const style = existing || document.createElement("style");
    style.id = styleId;
    style.setAttribute("data-shellx-ad-filter", "true");
    const presentationRule = mode === "visualCleanCompatibility"
      ? "visibility: hidden !important; pointer-events: none !important;"
      : "display: none !important; pointer-events: none !important;";
    style.textContent = `${persistentPresentationSelectors.join(",\n")} {\n  ${presentationRule}\n}`;
    if (!existing) {
      (document.head || document.documentElement).appendChild(style);
    }
  };

  if (!window.__shellxBeforeUnloadMonitorInstalled) {
    window.__shellxBeforeUnloadMonitorInstalled = true;
    window.__shellxBeforeUnloadRegistered = Boolean(window.onbeforeunload);
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    const originalRemoveEventListener = EventTarget.prototype.removeEventListener;
    const beforeUnloadWrappers = new WeakMap();
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if (String(type || "").toLowerCase() === "beforeunload" && (this === window || this === globalThis)) {
        window.__shellxBeforeUnloadRegistered = true;
        if (typeof listener === "function") {
          const wrapped = function(event) {
            if (window.__shellxApprovedBeforeUnloadNavigation) {
              event.stopImmediatePropagation();
              event.stopPropagation();
              try { delete event.returnValue; } catch (_) {}
              return undefined;
            }
            return listener.call(this, event);
          };
          beforeUnloadWrappers.set(listener, wrapped);
          return originalAddEventListener.call(this, type, wrapped, options);
        }
      }
      return originalAddEventListener.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function(type, listener, options) {
      if (String(type || "").toLowerCase() === "beforeunload" && typeof listener === "function") {
        const wrapped = beforeUnloadWrappers.get(listener);
        if (wrapped) {
          beforeUnloadWrappers.delete(listener);
          return originalRemoveEventListener.call(this, type, wrapped, options);
        }
      }
      return originalRemoveEventListener.call(this, type, listener, options);
    };
    try {
      let onBeforeUnloadValue = window.onbeforeunload;
      Object.defineProperty(window, "onbeforeunload", {
        configurable: true,
        get() { return onBeforeUnloadValue; },
        set(value) {
          onBeforeUnloadValue = value;
          if (value) window.__shellxBeforeUnloadRegistered = true;
        }
      });
    } catch (_) {}
  }

  if (!window.__shellxPrivacyNetworkGuardsInstalled) {
    window.__shellxPrivacyNetworkGuardsInstalled = true;
    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function(input, init) {
        const raw = typeof input === "string" ? input : input?.url;
        if (activeMode() && isAdUrl(raw)) {
          markBlocked();
          return Promise.resolve(new Response("", { status: 204, statusText: "ShellX filtered" }));
        }
        return originalFetch.call(this, input, init);
      };
    }
    const originalSendBeacon = navigator.sendBeacon;
    if (typeof originalSendBeacon === "function") {
      navigator.sendBeacon = function(url, data) {
        if (activeMode() && isAdUrl(url)) {
          markBlocked();
          return true;
        }
        return originalSendBeacon.call(this, url, data);
      };
    }
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__shellxBlockedAdRequest = Boolean(activeMode() && isAdUrl(url));
      if (this.__shellxBlockedAdRequest) {
        markBlocked();
        return originalOpen.call(this, method, "about:blank", ...rest);
      }
      return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(body) {
      if (this.__shellxBlockedAdRequest) {
        try { this.abort(); } catch (_) {}
        return undefined;
      }
      return originalSend.call(this, body);
    };
    const originalAppendChild = Node.prototype.appendChild;
    const originalInsertBefore = Node.prototype.insertBefore;
    const shouldSuppressNode = (node) => {
      if (!activeMode() || !(node instanceof Element)) return false;
      const raw = node.getAttribute("src") || node.getAttribute("href") || node.getAttribute("data-src") || "";
      return Boolean(raw && isAdUrl(raw));
    };
    Node.prototype.appendChild = function(node) {
      if (shouldSuppressNode(node)) {
        markBlocked();
        node.setAttribute?.("data-shellx-ad-blocked", "true");
        return node;
      }
      return originalAppendChild.call(this, node);
    };
    Node.prototype.insertBefore = function(node, child) {
      if (shouldSuppressNode(node)) {
        markBlocked();
        node.setAttribute?.("data-shellx-ad-blocked", "true");
        return node;
      }
      return originalInsertBefore.call(this, node, child);
    };
    const originalWindowOpen = window.open;
    if (typeof originalWindowOpen === "function") {
      window.open = function(url, target, features) {
        if (activeMode() && isAdUrl(url)) {
          markBlocked();
          return null;
        }
        return originalWindowOpen.call(this, url, target, features);
      };
    }
  }

  const balancedPresentationSelectors = [
    "amp-ad",
    "amp-embed[type='doubleclick']",
    "ins.adsbygoogle",
    ".adsbygoogle",
    "iframe[src*='doubleclick']",
    "iframe[src*='googlesyndication']",
    "iframe[src*='googletagservices']",
    "iframe[src*='adform.net']",
    "iframe[src*='gemius']",
    "iframe[src*='adnxs']",
    "iframe[src*='/ads/']",
    "iframe[src*='/ad/']",
    "script[src*='doubleclick']",
    "script[src*='googlesyndication']",
    "script[src*='googletagmanager']",
    "script[src*='googletagservices']",
    "script[src*='google-analytics']",
    "script[src*='adform.net']",
    "script[src*='gemius']",
    "[aria-label*='advertisement' i]",
    "[aria-label*='sponsored' i]"
  ];
  const strictPresentationSelectors = [
    "[id*='ad-']",
    "[id^='ad_']",
    "[id$='-ad']",
    "[id$='_ad']",
    "[id*='advert']",
    "[id*='dfp']",
    "[class*=' ad-']",
    "[class^='ad-']",
    "[class$='-ad']",
    "[class*=' ads']",
    "[class*=' advert']",
    "[class*='advertisement']",
    "[class*='advertising']",
    "[class*=' adslot']",
    "[class*=' ad-unit']",
    "[class*=' sponsored']",
    "[class*='google-ad']",
    "[class*='dfp']",
    "[data-ad]",
    "[data-ad-client]",
    "[data-ad-slot]",
    "[data-ad-unit]",
    "[data-google-query-id]"
  ];
  const presentationSelectorsForMode = () => (
    mode === "strict"
      ? balancedPresentationSelectors.concat(strictPresentationSelectors)
      : []
  );
  const restoreLocalPresentation = () => {
    syncPrivacyStylesheet();
    for (const node of Array.from(document.querySelectorAll("[data-shellx-ad-filtered]"))) {
      if (!(node instanceof HTMLElement)) continue;
      const previousStyle = node.getAttribute("data-shellx-ad-previous-style");
      if (previousStyle === null || previousStyle === "") {
        node.removeAttribute("style");
      } else {
        node.setAttribute("style", previousStyle);
      }
      node.removeAttribute("data-local-clean");
      node.removeAttribute("data-shellx-ad-filtered");
      node.removeAttribute("data-shellx-ad-previous-style");
    }
    const current = ensureStats();
    current.hiddenElements = 0;
    current.maskedElements = 0;
    current.blockedRequests = 0;
    current.matchedElements = 0;
    current.lastRunAt = now();
    window.__shellxLastAppliedPrivacyMode = mode;
  };
  const visibleElement = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
  };
  const overlayLike = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const z = Number.parseInt(style.zIndex || "0", 10);
    return style.position === "fixed"
      || style.position === "sticky"
      || Number.isFinite(z) && z >= 20
      || (rect.width >= window.innerWidth * 0.45 && rect.height >= 40 && rect.top <= window.innerHeight * 0.85);
  };
  const findAdTextOverlayNodes = () => {
    const genericAdTextPattern = /(advertisement|advertising|sponsored)/i;
    const strongInterstitialPattern = /(aizv[eē]rt rekl[aā]m|port[aā]ls atv[eē]rsies)/i;
    const pattern = mode === "strict"
      ? /(advertisement|advertising|sponsored|close ad|skip ad|rekl[aā]m|aizv[eē]rt rekl[aā]m|port[aā]ls atv[eē]rsies)/i
      : strongInterstitialPattern;
    const directSelectors = [
      ".monster-overlay",
      ".monster-container",
      ".monster-header",
      ".close-ad-button",
      ".ad-countdown"
    ];
    const out = [];
    const consider = (node) => {
      if (!(node instanceof HTMLElement) || !visibleElement(node)) return;
      const text = String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 900 || !pattern.test(text)) return;
      const strongInterstitial = strongInterstitialPattern.test(text);
      if (mode !== "strict" && !strongInterstitial) return;
      let target = node;
      let current = node;
      for (let depth = 0; depth < 6 && current?.parentElement && current.parentElement !== document.body; depth += 1) {
        const parent = current.parentElement;
        const parentText = String(parent.innerText || parent.textContent || "").replace(/\s+/g, " ").trim();
        const parentStrongInterstitial = strongInterstitialPattern.test(parentText);
        const parentGenericAdText = genericAdTextPattern.test(parentText);
        if (
          parentText.length <= 1200
          && (parentStrongInterstitial || (mode === "strict" && parentGenericAdText))
          && overlayLike(parent)
        ) {
          target = parent;
        }
        current = parent;
      }
      if ((strongInterstitial || (mode === "strict" && overlayLike(target))) && !out.includes(target)) out.push(target);
    };
    for (const selector of directSelectors) {
      try {
        for (const node of Array.from(document.querySelectorAll(selector))) consider(node);
      } catch (_) {}
    }
    let examined = 0;
    const nodes = document.querySelectorAll("body *");
    for (const node of nodes) {
      examined += 1;
      consider(node);
      if (out.length >= 50 || examined >= 20000) break;
    }
    return out;
  };
  const applyLocalPresentation = () => {
    syncPrivacyStylesheet();
    if (!activeMode()) {
      restoreLocalPresentation();
      return;
    }
    if (window.__shellxLastAppliedPrivacyMode && window.__shellxLastAppliedPrivacyMode !== mode) {
      restoreLocalPresentation();
    }
    window.__shellxLastAppliedPrivacyMode = mode;
    const mask = mode === "visualCleanCompatibility";
    const current = ensureStats();
    let matched = 0;
    for (const selector of presentationSelectorsForMode()) {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(selector)); } catch (_) { nodes = []; }
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.closest("[data-shellx-ad-allow]")) continue;
        matched += 1;
        const alreadyFiltered = node.hasAttribute("data-shellx-ad-filtered");
        if (!alreadyFiltered) {
          node.setAttribute("data-shellx-ad-previous-style", node.getAttribute("style") || "");
          if (mask) current.maskedElements += 1;
          else current.hiddenElements += 1;
        }
        node.setAttribute("data-local-clean", mask ? "masked" : "hidden");
        node.setAttribute("data-shellx-ad-filtered", mask ? "masked" : "hidden");
        node.style.setProperty("pointer-events", "none", "important");
        if (mask) {
          node.style.setProperty("visibility", "hidden", "important");
        } else {
          node.style.setProperty("display", "none", "important");
        }
      }
    }
    for (const node of findAdTextOverlayNodes()) {
      matched += 1;
      const alreadyFiltered = node.hasAttribute("data-shellx-ad-filtered");
      if (!alreadyFiltered) {
        node.setAttribute("data-shellx-ad-previous-style", node.getAttribute("style") || "");
        if (mask) current.maskedElements += 1;
        else current.hiddenElements += 1;
      }
      node.setAttribute("data-local-clean", mask ? "masked" : "hidden");
      node.setAttribute("data-shellx-ad-filtered", mask ? "masked" : "hidden");
      node.style.setProperty("pointer-events", "none", "important");
      if (mask) {
        node.style.setProperty("visibility", "hidden", "important");
      } else {
        node.style.setProperty("display", "none", "important");
      }
    }
    current.matchedElements = matched;
    current.lastRunAt = now();
  };
  const schedule = () => {
    if (privacyGeneration !== window.__shellxPrivacyGeneration) return;
    if (document.__localCleanScheduled) return;
    document.__localCleanScheduled = true;
    requestAnimationFrame(() => {
      if (privacyGeneration !== window.__shellxPrivacyGeneration) return;
      document.__localCleanScheduled = false;
      applyLocalPresentation();
    });
  };
  window.__shellxPrivacySchedule = schedule;
  if (!activeMode()) {
    resetPrivacyStatsForOffMode();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", schedule, { once: true });
  } else {
    applyLocalPresentation();
  }
  if (!window.__shellxPrivacyObserverInstalled) {
    window.__shellxPrivacyObserverInstalled = true;
    new MutationObserver(() => {
      try { window.__shellxPrivacySchedule?.(); } catch (_) {}
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true, attributeFilter: ["src", "href", "class", "id"] });
  }
  for (const delay of [250, 1000, 2500, 5000, 9000]) {
    setTimeout(schedule, delay);
  }
  return { ok: true, mode, privacyStats: snapshot() };
})()
"#
    .replace("__SHELLX_PRIVACY_MODE__", &mode)
}
