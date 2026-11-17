(() => {
  const previewSchema = "shellx.public-manual-preview.v1";
  const featurePattern = /^shellx\.[a-z0-9_.-]{1,180}$/;
  const interfaceRoot = document.querySelector("[data-interface-map]");
  const dataNode = document.querySelector("[data-interface-map-data]");
  const frame = document.querySelector("[data-manual-preview]");
  const guide = document.querySelector("[data-manual-guide]");
  const guideToggle = document.querySelector("[data-manual-guide-toggle]");
  const guideClose = document.querySelector("[data-manual-guide-close]");
  const status = document.querySelector("[data-manual-preview-status]");
  const detailTitle = document.querySelector("[data-detail-title]");
  const detailDescription = document.querySelector("[data-detail-description]");
  const detailState = document.querySelector("[data-detail-state]");
  const detailSection = document.querySelector("[data-detail-section]");
  const detailSteps = document.querySelector("[data-detail-steps]");
  const detailNote = document.querySelector("[data-detail-note]");
  const detailNoteText = document.querySelector("[data-detail-note-text]");
  const detailArticleLink = document.querySelector("[data-detail-article-link]");
  const detailHandoff = document.querySelector("[data-detail-handoff]");
  const search = document.querySelector("[data-manual-search]");
  const searchStatus = document.querySelector("[data-search-status]");
  const searchEmpty = document.querySelector("[data-manual-search-empty]");
  const emptyState = document.querySelector("[data-empty-state]");
  const treeLinks = Array.from(document.querySelectorAll("[data-feature-link]"));
  const articles = Array.from(document.querySelectorAll("[data-feature-id]"));
  const sections = Array.from(document.querySelectorAll("[data-manual-section]"));
  const features = parseFeatures(dataNode?.textContent);
  const featureByDebugId = new Map();
  let selectedFeatureId = interfaceRoot?.dataset.defaultFeature || "shellx.interface.header.find";
  let previewKind = "shellx";
  let selectionDelivery = 0;
  const compactGuide = window.matchMedia("(max-width: 760px)");

  for (const item of Object.values(features)) {
    if (item?.previewFocusId && !featureByDebugId.has(item.previewFocusId)) {
      featureByDebugId.set(item.previewFocusId, item.id);
    }
  }

  function parseFeatures(text) {
    try {
      const parsed = JSON.parse(text || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function setGuideOpen(open, { focusSearch = false } = {}) {
    const nextOpen = compactGuide.matches ? open : true;
    guide?.classList.toggle("is-open", nextOpen);
    guide?.setAttribute("aria-hidden", String(!nextOpen));
    guideToggle?.setAttribute("aria-expanded", String(nextOpen));
    if (nextOpen && (compactGuide.matches || focusSearch)) {
      window.requestAnimationFrame(() => search?.focus({ preventScroll: true }));
    }
  }

  function previewForState(stateId) {
    return stateId.startsWith("browser-") ? "browser" : "shellx";
  }

  function previewUrl(kind) {
    return kind === "browser" ? "./app/manual-browser.html" : "./app/manual-shellx.html";
  }

  function highlightColor(item) {
    if (item.state.id.startsWith("browser-")) return "blue";
    if (item.state.id.startsWith("settings-")) return "magenta";
    if (item.state.id.startsWith("task-manager-") || item.section === "Tasks") return "orange";
    if (item.section.includes("Vault") || item.state.id === "header-requests") return "yellow";
    if (item.section.includes("Build") || item.state.id.startsWith("bottom-trace")) return "green";
    return "cyan";
  }

  function postSelection(item) {
    if (!frame?.contentWindow) return;
    frame.contentWindow.postMessage({
      schema: previewSchema,
      kind: "show-state",
      featureId: item.id,
      stateId: item.state.id,
      ...(item.previewFocusId ? { focusDebugId: item.previewFocusId } : {}),
      highlightLabel: item.label.slice(0, 80),
      highlightColor: highlightColor(item),
    }, window.location.origin);
  }

  function scheduleSelection(item) {
    const delivery = ++selectionDelivery;
    for (const delay of [0, 80, 220, 500, 900]) {
      window.setTimeout(() => {
        if (delivery !== selectionDelivery || selectedFeatureId !== item.id) return;
        postSelection(item);
      }, delay);
    }
  }

  function renderSteps(steps) {
    if (!detailSteps) return;
    detailSteps.replaceChildren();
    for (const step of steps || []) {
      const li = document.createElement("li");
      li.textContent = step;
      detailSteps.append(li);
    }
    detailSteps.hidden = detailSteps.childElementCount === 0;
  }

  function renderHandoff(item) {
    if (!detailHandoff) return;
    detailHandoff.replaceChildren();
    detailHandoff.hidden = true;
    const localManual = window.location.protocol === "file:"
      || ["localhost", "127.0.0.1"].includes(window.location.hostname);
    if (!localManual || item.handoff?.availability !== "supported") return;
    const link = document.createElement("a");
    link.href = `shellx-app://manual/open?feature=${encodeURIComponent(item.id)}&v=1`;
    link.textContent = "Show in my ShellX";
    detailHandoff.append(link);
    detailHandoff.hidden = false;
  }

  function setSelectedFeature(featureId, { openGuide = true, updateUrl = true } = {}) {
    if (!featurePattern.test(featureId) || !Object.hasOwn(features, featureId)) return;
    const item = features[featureId];
    selectedFeatureId = featureId;
    detailTitle && (detailTitle.textContent = item.label);
    detailDescription && (detailDescription.textContent = item.summary);
    detailState && (detailState.textContent = item.state.label);
    detailSection && (detailSection.textContent = item.section);
    if (detailArticleLink) detailArticleLink.href = `#${item.id}`;
    renderSteps(item.steps);
    const note = item.note || item.visualNote || "";
    if (detailNoteText) detailNoteText.textContent = note;
    if (detailNote) detailNote.hidden = !note;
    renderHandoff(item);

    for (const link of treeLinks) {
      const selected = link.dataset.featureLink === featureId;
      link.classList.toggle("is-active", selected);
      if (selected) {
        link.setAttribute("aria-current", "true");
        link.closest("details")?.setAttribute("open", "");
      } else {
        link.removeAttribute("aria-current");
      }
    }

    const nextKind = previewForState(item.state.id);
    if (nextKind !== previewKind) {
      previewKind = nextKind;
      frame.src = previewUrl(nextKind);
    }
    scheduleSelection(item);
    if (status) status.textContent = `${item.state.label} · ${item.label}`;
    if (openGuide) setGuideOpen(true);
    if (compactGuide.matches && guide?.classList.contains("is-open")) {
      guide.scrollTop = 0;
      window.scrollTo(0, 0);
    }
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set("feature", featureId);
      history.replaceState(null, "", url);
    }
  }

  guideToggle?.addEventListener("click", () => {
    const open = !guide?.classList.contains("is-open");
    setGuideOpen(open, { focusSearch: open });
  });
  guideClose?.addEventListener("click", () => setGuideOpen(false));
  compactGuide.addEventListener("change", () => setGuideOpen(!compactGuide.matches));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && guide?.classList.contains("is-open")) setGuideOpen(false);
  });

  for (const link of treeLinks) {
    link.addEventListener("click", () => setSelectedFeature(link.dataset.featureLink || ""));
  }

  frame?.addEventListener("load", () => {
    const item = features[selectedFeatureId];
    if (item) scheduleSelection(item);
  });

  window.addEventListener("message", (event) => {
    if (event.source !== frame?.contentWindow || event.origin !== window.location.origin) return;
    const value = event.data;
    if (!value || typeof value !== "object" || value.schema !== previewSchema) return;
    if (value.kind === "ready") {
      const item = features[selectedFeatureId];
      if (item) scheduleSelection(item);
      return;
    }
    if (value.kind !== "control") return;
    const featureId = featureByDebugId.get(value.debugId);
    if (featureId) setSelectedFeature(featureId, { openGuide: true });
  });

  search?.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    for (const link of treeLinks) {
      const item = features[link.dataset.featureLink || ""];
      const haystack = `${item?.label || ""} ${item?.summary || ""} ${item?.section || ""}`.toLowerCase();
      const match = !query || haystack.includes(query);
      link.hidden = !match;
      if (match) {
        visible += 1;
        link.closest("details")?.setAttribute("open", "");
      }
    }
    if (searchStatus) {
      searchStatus.textContent = query
        ? (visible ? `${visible} matching features` : "No matching features")
        : `${treeLinks.length} documented features`;
    }
    if (searchEmpty) searchEmpty.hidden = visible !== 0;
    filterReference(query);
  });

  function filterReference(query) {
    let visible = 0;
    for (const article of articles) {
      const match = !query || (article.dataset.searchText || "").includes(query);
      article.hidden = !match;
      if (match) visible += 1;
    }
    for (const section of sections) {
      section.hidden = !Array.from(section.querySelectorAll("[data-feature-id]")).some((article) => !article.hidden);
    }
    if (emptyState) emptyState.hidden = visible !== 0;
  }

  const initial = new URLSearchParams(window.location.search).get("feature");
  if (initial && Object.hasOwn(features, initial)) {
    setSelectedFeature(initial, { openGuide: true, updateUrl: false });
  } else {
    setSelectedFeature(selectedFeatureId, { openGuide: false, updateUrl: false });
    setGuideOpen(!compactGuide.matches);
  }
  filterReference("");
  if (searchStatus) searchStatus.textContent = `${treeLinks.length} documented features`;
})();
