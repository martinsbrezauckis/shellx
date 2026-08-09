(() => {
  const search = document.querySelector("[data-manual-search]");
  const status = document.querySelector("[data-search-status]");
  const empty = document.querySelector("[data-empty-state]");
  const links = Array.from(document.querySelectorAll("[data-feature-link]"));
  const features = Array.from(document.querySelectorAll("[data-feature-id]"));
  const sections = Array.from(document.querySelectorAll("[data-manual-section]"));
  const featuresById = new Map(features.map((feature) => [feature.dataset.featureId, feature]));
  const navToggle = document.querySelector("[data-manual-nav-toggle]");
  const nav = document.querySelector("[data-manual-nav]");
  const navSymbol = document.querySelector("[data-manual-nav-symbol]");
  const interfaceMap = document.querySelector("[data-interface-map]");
  const interfaceMapImage = document.querySelector("[data-interface-map-image]");
  const interfaceMapDataNode = document.querySelector("[data-interface-map-data]");
  const interfaceMapData = parseInterfaceMapData(interfaceMapDataNode?.textContent);
  const highlight = document.querySelector("[data-manual-highlight]");
  const surfaceLink = document.querySelector("[data-map-open-image]");
  const detailTitle = document.querySelector("[data-detail-title]");
  const detailDescription = document.querySelector("[data-detail-description]");
  const detailView = document.querySelector("[data-detail-view]");
  const detailSection = document.querySelector("[data-detail-section]");
  const detailId = document.querySelector("[data-detail-id]");
  const detailSteps = document.querySelector("[data-detail-steps]");
  const detailNote = document.querySelector("[data-detail-note]");
  const detailNoteText = document.querySelector("[data-detail-note-text]");
  const detailOpenImage = document.querySelector("[data-detail-open-image]");
  const detailArticleLink = document.querySelector("[data-detail-article-link]");

  function parseInterfaceMapData(text) {
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function captureAssetHref(feature) {
    const file = feature?.capture?.file;
    return typeof file === "string" && /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(file)
      ? `./${file}`
      : null;
  }

  function featureFragmentHref(featureId) {
    return typeof featureId === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(featureId)
      ? `#${featureId}`
      : null;
  }

  function setNavOpen(open) {
    nav?.classList.toggle("is-open", open);
    navToggle?.setAttribute("aria-expanded", String(open));
    if (navSymbol) navSymbol.textContent = open ? "−" : "+";
  }

  navToggle?.addEventListener("click", () => {
    setNavOpen(navToggle.getAttribute("aria-expanded") !== "true");
  });

  function updateInterfaceMap(featureId) {
    if (!Object.hasOwn(interfaceMapData, featureId)) return false;
    const feature = interfaceMapData[featureId];
    const imagePath = captureAssetHref(feature);
    const articleHref = featureFragmentHref(feature?.id);
    const focus = feature?.focus;
    if (
      !imagePath ||
      !articleHref ||
      typeof feature.label !== "string" ||
      typeof feature.summary !== "string" ||
      typeof feature.section !== "string" ||
      !Array.isArray(feature.steps) ||
      !Array.isArray(focus) ||
      focus.length !== 4 ||
      !focus.every(Number.isFinite) ||
      !Number.isFinite(feature.capture.width) ||
      !Number.isFinite(feature.capture.height)
    ) return false;
    if (interfaceMapImage) {
      interfaceMapImage.setAttribute("src", imagePath);
      interfaceMapImage.width = feature.capture.width;
      interfaceMapImage.height = feature.capture.height;
      interfaceMapImage.alt = `ShellX interface showing ${feature.label}`;
    }
    if (highlight) {
      const [left, top, width, height] = focus;
      highlight.style.left = `${left}%`;
      highlight.style.top = `${top}%`;
      highlight.style.width = `${width}%`;
      highlight.style.height = `${height}%`;
      highlight.dataset.label = feature.label;
      highlight.dataset.labelSide = top > 74 ? "above" : "below";
      highlight.dataset.labelAlign = left > 68 ? "end" : "start";
    }
    if (surfaceLink) {
      surfaceLink.setAttribute("href", imagePath);
      surfaceLink.setAttribute("aria-label", `Open full UI capture for ${feature.label}`);
    }
    if (detailTitle) detailTitle.textContent = feature.label;
    if (detailDescription) detailDescription.textContent = feature.summary;
    if (detailView) detailView.textContent = feature.capture.label;
    if (detailSection) detailSection.textContent = feature.section;
    if (detailId) detailId.textContent = feature.id;
    if (detailSteps) {
      detailSteps.replaceChildren(...feature.steps.map((step) => {
        const item = document.createElement("li");
        item.textContent = step;
        return item;
      }));
      detailSteps.hidden = feature.steps.length === 0;
    }
    const note = feature.note || feature.visualNote;
    if (detailNote && detailNoteText) {
      detailNoteText.textContent = note;
      detailNote.hidden = !note;
    }
    if (detailOpenImage) detailOpenImage.setAttribute("href", imagePath);
    if (detailArticleLink) detailArticleLink.setAttribute("href", articleHref);
    if (interfaceMap) interfaceMap.dataset.selectedFeature = featureId;
    return true;
  }

  function selectFeature(featureId, options = {}) {
    const target = featuresById.get(featureId);
    if (!target) return false;
    const mapped = updateInterfaceMap(featureId);
    for (const feature of features) feature.classList.toggle("highlighted", feature === target);
    for (const link of links) link.classList.toggle("active", link.dataset.featureLink === featureId);
    if (options.updateUrl !== false) {
      const url = new URL(window.location.href);
      url.searchParams.set("feature", featureId);
      window.history.replaceState({}, "", url);
    }
    if (window.matchMedia("(max-width: 900px)").matches) setNavOpen(false);
    if (options.scroll !== false) (mapped ? interfaceMap : target)?.scrollIntoView({ behavior: "smooth", block: "start" });
    return true;
  }

  for (const link of links) {
    link.addEventListener("click", () => selectFeature(link.dataset.featureLink));
  }

  function applySearch() {
    const query = (search?.value || "").trim().toLowerCase();
    let visible = 0;
    for (const feature of features) {
      const match = !query || feature.dataset.searchText.includes(query);
      feature.hidden = !match;
      if (match) visible += 1;
    }
    for (const link of links) {
      const target = featuresById.get(link.dataset.featureLink);
      link.hidden = Boolean(target?.hidden);
    }
    for (const section of sections) {
      section.hidden = !Array.from(section.querySelectorAll("[data-feature-id]")).some((feature) => !feature.hidden);
    }
    if (status) status.textContent = query ? `${visible} matching surface${visible === 1 ? "" : "s"}` : "";
    if (empty) empty.hidden = visible !== 0;
  }

  search?.addEventListener("input", applySearch);

  const requested = new URL(window.location.href).searchParams.get("feature") || window.location.hash.slice(1);
  if (requested) {
    window.requestAnimationFrame(() => selectFeature(requested, { updateUrl: false }));
  } else {
    const firstMappedFeature = interfaceMap?.dataset.defaultFeature || features
      .map((feature) => feature.dataset.featureId)
      .find((featureId) => featureId && Object.hasOwn(interfaceMapData, featureId));
    if (firstMappedFeature) selectFeature(firstMappedFeature, { updateUrl: false, scroll: false });
  }
})();
