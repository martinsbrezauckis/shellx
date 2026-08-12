#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentPath = join(repoRoot, "docs", "public", "manual", "shellx", "content.json");
const visualsPath = join(repoRoot, "docs", "public", "manual", "shellx", "visuals.json");
const htmlPath = join(repoRoot, "docs", "public", "manual", "shellx", "index.html");
const markdownPath = join(repoRoot, "docs", "public", "SHELLX_MANUAL.md");
const packagePath = join(repoRoot, "package.json");
const staticFiles = ["manual.css", "manual.js", "visuals.json"];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readManualContent() {
  const content = readJsonFile(contentPath, "ShellX manual content");
  const pkg = readJsonFile(packagePath, "package metadata");
  if (content.schema !== "shellx.manual-content.v1") {
    throw new Error(`Unsupported manual schema: ${content.schema ?? "missing"}`);
  }
  if (content.version !== pkg.version) {
    throw new Error(
      `Manual version ${content.version} does not match package.json ${pkg.version}. Update ${contentPath}.`,
    );
  }
  if (!Number.isInteger(content.revision) || content.revision < 1) {
    throw new Error("Manual content must define a positive integer revision for static-asset cache busting.");
  }
  if (!Array.isArray(content.sections) || content.sections.length === 0) {
    throw new Error("Manual must contain at least one section.");
  }
  const ids = new Set();
  for (const section of content.sections) {
    if (!section.id || !section.title || !Array.isArray(section.features) || section.features.length === 0) {
      throw new Error(`Invalid manual section: ${JSON.stringify(section)}`);
    }
    for (const feature of section.features) {
      if (!feature.id || !feature.label || !feature.summary) {
        throw new Error(`Invalid feature in ${section.id}: ${JSON.stringify(feature)}`);
      }
      if (ids.has(feature.id)) throw new Error(`Duplicate manual feature id: ${feature.id}`);
      ids.add(feature.id);
    }
  }
  return content;
}

function readManualVisuals(content) {
  const visuals = readJsonFile(visualsPath, "ShellX manual visuals");
  if (visuals.schema !== "shellx.manual-visuals.v1") {
    throw new Error(`Unsupported manual visuals schema: ${visuals.schema ?? "missing"}`);
  }
  if (!visuals.captures || typeof visuals.captures !== "object" || !visuals.features || typeof visuals.features !== "object") {
    throw new Error("Manual visuals must define captures and features objects.");
  }
  for (const [captureId, capture] of Object.entries(visuals.captures)) {
    if (!capture.file || !Number.isFinite(capture.width) || !Number.isFinite(capture.height)) {
      throw new Error(`Invalid manual capture ${captureId}: ${JSON.stringify(capture)}`);
    }
    const path = join(repoRoot, "docs", "public", "manual", "shellx", capture.file);
    if (!existsSync(path)) throw new Error(`Manual capture file is missing: ${path}`);
  }
  const interfaceFeatures = content.sections
    .filter((section) => section.id === "interface" || section.id === "browser-interface")
    .flatMap((section) => section.features);
  for (const feature of interfaceFeatures) {
    const visual = visuals.features[feature.id];
    if (!visual) throw new Error(`Manual interface feature has no visual mapping: ${feature.id}`);
    if (!visuals.captures[visual.capture]) {
      throw new Error(`Manual visual ${feature.id} references unknown capture ${visual.capture ?? "missing"}`);
    }
    if (!Array.isArray(visual.focus) || visual.focus.length !== 4 || visual.focus.some((value) => !Number.isFinite(value))) {
      throw new Error(`Manual visual ${feature.id} has an invalid focus rectangle.`);
    }
    const [x, y, width, height] = visual.focus;
    if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 100.01 || y + height > 100.01) {
      throw new Error(`Manual visual ${feature.id} focus rectangle falls outside its capture.`);
    }
  }
  return visuals;
}

function renderFeatureArticle(feature) {
  const steps = Array.isArray(feature.steps) && feature.steps.length > 0
    ? `<ol>${feature.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>`
    : "";
  const note = feature.note
    ? `<p class="manual-note"><strong>Boundary</strong>${escapeHtml(feature.note)}</p>`
    : "";
  return `<article class="feature-detail" id="${escapeHtml(feature.id)}" data-feature-id="${escapeHtml(feature.id)}" data-search-text="${escapeHtml(`${feature.label} ${feature.summary} ${(feature.steps ?? []).join(" ")} ${feature.note ?? ""}`.toLowerCase())}">
  <div class="feature-heading">
    <p>${escapeHtml(feature.id)}</p>
    <a href="?feature=${encodeURIComponent(feature.id)}" aria-label="Link to ${escapeHtml(feature.label)}">Link</a>
  </div>
  <h3>${escapeHtml(feature.label)}</h3>
  <p class="feature-summary">${escapeHtml(feature.summary)}</p>
  ${steps}
  ${note}
</article>`;
}

function captureLabel(captureId, capture) {
  if (capture.label) return capture.label;
  return captureId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function interfaceFeatures(content) {
  return content.sections
    .filter((section) => section.id === "interface" || section.id === "browser-interface")
    .flatMap((section) => section.features.map((feature) => ({ ...feature, sectionTitle: section.title })));
}

function renderInterfaceMap(content, visuals) {
  const features = interfaceFeatures(content);
  const map = Object.fromEntries(features.map((feature) => {
    const visual = visuals.features[feature.id];
    const capture = visuals.captures[visual.capture];
    return [feature.id, {
      id: feature.id,
      label: feature.label,
      summary: feature.summary,
      steps: feature.steps ?? [],
      note: feature.note ?? "",
      section: feature.sectionTitle,
      focus: visual.focus,
      visualNote: visual.note ?? "",
      capture: {
        id: visual.capture,
        label: captureLabel(visual.capture, capture),
        file: capture.file,
        width: capture.width,
        height: capture.height,
      },
    }];
  }));
  const defaultFeatureId = "shellx.interface.header.find";
  const initial = map[defaultFeatureId] ?? map[features[0].id];
  const [x, y, width, height] = initial.focus;
  const labelSide = y > 74 ? "above" : "below";
  const labelAlign = x > 68 ? "end" : "start";
  const data = JSON.stringify(map).replaceAll("<", "\\u003c");
  return `<section class="manual-section interface-map-section" id="interface-map" data-interface-map data-default-feature="${escapeHtml(initial.id)}">
  <header class="section-heading">
    <p>interface map</p>
    <h2>Click a control to see where it lives.</h2>
    <span>One live map switches between the current ShellX and Browser views. The highlight and explanation update without repeating screenshots down the page.</span>
  </header>
  <div class="manual-surface" data-interface-map-surface>
    <a class="manual-surface-link" href="./${escapeHtml(initial.capture.file)}" target="_blank" rel="noreferrer" data-map-open-image aria-label="Open full UI capture for ${escapeHtml(initial.label)}">
      <img src="./${escapeHtml(initial.capture.file)}" width="${initial.capture.width}" height="${initial.capture.height}" alt="ShellX interface showing ${escapeHtml(initial.label)}" data-interface-map-image />
      <span class="manual-highlight" data-manual-highlight data-label="${escapeHtml(initial.label)}" data-label-side="${labelSide}" data-label-align="${labelAlign}" style="left:${x}%;top:${y}%;width:${width}%;height:${height}%" aria-hidden="true"></span>
    </a>
  </div>
  <article class="manual-detail" aria-live="polite">
    <p class="manual-eyebrow">Selected control</p>
    <h3 data-detail-title>${escapeHtml(initial.label)}</h3>
    <p data-detail-description>${escapeHtml(initial.summary)}</p>
    <div class="detail-meta">
      <div><span>View</span><strong data-detail-view>${escapeHtml(initial.capture.label)}</strong></div>
      <div><span>Section</span><strong data-detail-section>${escapeHtml(initial.section)}</strong></div>
      <div><span>Feature ID</span><strong data-detail-id>${escapeHtml(initial.id)}</strong></div>
    </div>
    <ol class="manual-detail-steps" data-detail-steps${initial.steps.length ? "" : " hidden"}>${initial.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
    <p class="manual-note" data-detail-note${initial.note || initial.visualNote ? "" : " hidden"}><strong>Boundary</strong><span data-detail-note-text>${escapeHtml(initial.note || initial.visualNote)}</span></p>
    <div class="manual-detail-actions">
      <a href="./${escapeHtml(initial.capture.file)}" target="_blank" rel="noreferrer" data-detail-open-image>Open full image</a>
      <a href="#${escapeHtml(initial.id)}" data-detail-article-link>Read the manual entry</a>
    </div>
  </article>
  <script type="application/json" data-interface-map-data>${data}</script>
</section>`;
}

function renderHtml(content, visuals) {
  const featureCount = content.sections.reduce((count, section) => count + section.features.length, 0);
  const assetRevision = `${content.version}.${content.revision}`;
  const interfaceMap = renderInterfaceMap(content, visuals);
  const tree = content.sections.map((section) => `<details class="manual-folder" open>
  <summary>${escapeHtml(section.title)}</summary>
  <div class="manual-tree-subgroup">${escapeHtml(section.summary)}</div>
  ${section.features.map((feature) => `<button class="manual-node" type="button" data-feature-link="${escapeHtml(feature.id)}">${escapeHtml(feature.label)}</button>`).join("\n  ")}
</details>`).join("\n");

  const sections = content.sections.map((section) => `<section class="manual-section" id="section-${escapeHtml(section.id)}" data-manual-section>
  <header class="section-heading">
    <p>${escapeHtml(section.id)}</p>
    <h2>${escapeHtml(section.title)}</h2>
    <span>${escapeHtml(section.summary)}</span>
  </header>
  <div class="feature-list">
    ${section.features.map((feature) => renderFeatureArticle(feature)).join("\n")}
  </div>
</section>`).join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(content.title)}</title>
    <meta name="description" content="ShellX desktop workspace manual for agents, Browser, Vault, connections, and verification." />
    <meta name="robots" content="index,follow" />
    <meta name="theme-color" content="#050505" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23070707'/%3E%3Cpath d='M8 7l16 18M24 7L8 25' stroke='%23c8423a' stroke-width='3'/%3E%3C/svg%3E" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT@9..144,300..700,0..100&family=JetBrains+Mono:wght@400;500&family=Onest:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="./manual.css?v=${encodeURIComponent(assetRevision)}" />
    <script src="./manual.js?v=${encodeURIComponent(assetRevision)}" defer></script>
  </head>
  <body class="manual-body">
    <header class="manual-topbar">
      <a class="manual-brand" href="../../"><span class="manual-mark">X</span><span>ShellX Docs</span></a>
      <nav class="manual-topnav" aria-label="Product manuals">
        <a aria-current="page" href="./">ShellX</a>
        <a href="../cut/">Cut</a>
        <a href="../canvas/">Design Studio</a>
        <span class="manual-muted" aria-label="Drive manual coming later">Drive</span>
        <a href="../vault/">Vault</a>
        <a href="../motion/">Motion</a>
        <span class="manual-muted" aria-label="Browser manual coming later">Browser</span>
      </nav>
    </header>
    <div class="manual-shell">
      <aside class="manual-tree" aria-label="ShellX manual sections">
        <div class="manual-product">
          <h2>ShellX</h2>
          <span class="manual-version" data-app-version="${escapeHtml(content.version)}">v${escapeHtml(content.version)}</span>
        </div>
        <button class="manual-nav-toggle" type="button" aria-expanded="false" aria-controls="manual-tree-navigation" data-manual-nav-toggle>
          <span>Browse ${featureCount} features</span><span aria-hidden="true" data-manual-nav-symbol>+</span>
        </button>
        <div class="manual-tree-navigation" id="manual-tree-navigation" data-manual-nav>
          <label class="manual-search-label" for="manual-search">Find a feature</label>
          <input id="manual-search" class="manual-search" type="search" placeholder="Browser, Vault, SSH…" autocomplete="off" data-manual-search />
          <p class="search-status" data-search-status aria-live="polite"></p>
          ${tree}
        </div>
      </aside>
      <main class="manual-content">
        <section class="manual-hero">
          <p class="manual-eyebrow">${escapeHtml(content.eyebrow)}</p>
          <h1>One visible workspace for agents, the web, secrets, and proof.</h1>
          <p>${escapeHtml(content.intro)}</p>
          <div class="hero-meta">
            <span>Updated ${escapeHtml(content.updated)}</span>
            <span>${featureCount} documented surfaces</span>
          </div>
          <p class="candidate-note">${escapeHtml(content.releaseNote)}</p>
          <figure class="manual-overview-visual">
            <img src="./assets/shellx-workspace.png" width="1920" height="1200" decoding="async" alt="ShellX v${escapeHtml(content.version)} workspace with header, projects, session, composer, and right rail visible" />
            <figcaption><strong>Interface map</strong><span>Select a persistent ShellX or Browser control in the left tree to update one interactive highlight below.</span></figcaption>
          </figure>
        </section>
        <div class="boundary-strip" role="note">
          <strong>Operator boundary</strong>
          <span>Provider-native tools handle ordinary project work. ShellX Browser, Vault, and host tools activate only in a confirmed ShellX session and keep sensitive actions visible.</span>
        </div>
        ${interfaceMap}
        ${sections}
        <p class="empty-state" data-empty-state hidden>No manual features match this search.</p>
      </main>
    </div>
  </body>
</html>
`.replace(/[ \t]+$/gm, "");
}

function renderMarkdown(content) {
  const body = content.sections.map((section) => {
    const features = section.features.map((feature) => {
      const steps = (feature.steps ?? []).map((step, index) => `${index + 1}. ${step}`).join("\n");
      const note = feature.note ? `\n\n> Boundary: ${feature.note}` : "";
      return `### ${feature.label}\n\n<a id="${feature.id}"></a>\n\n${feature.summary}${steps ? `\n\n${steps}` : ""}${note}`;
    }).join("\n\n");
    return `## ${section.title}\n\n${section.summary}\n\n${features}`;
  }).join("\n\n");
  return `<!-- Generated by scripts/generate-shellx-docs.mjs from docs/public/manual/shellx/content.json. -->\n\n# ${content.title}\n\nVersion: ${content.version}\n\nUpdated: ${content.updated}\n\n${content.intro}\n\n> ${content.releaseNote}\n\nWeb manual: https://docs.theshellx.com/manual/shellx/\n\n${body}\n`;
}

function writeGenerated(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

function compareGenerated(path, expected, errors) {
  if (!existsSync(path)) {
    errors.push(`missing generated file: ${path}`);
    return;
  }
  const actual = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
  if (actual !== expected.replaceAll("\r\n", "\n")) errors.push(`stale generated file: ${path}`);
}

function compareCopiedFile(target, source, errors) {
  if (!existsSync(source)) {
    errors.push(`missing source file: ${source}`);
    return;
  }
  if (!existsSync(target)) {
    errors.push(`missing synchronized file: ${target}`);
    return;
  }
  if (!readFileSync(target).equals(readFileSync(source))) errors.push(`stale synchronized file: ${target}`);
}

function visualAssetFiles(visuals) {
  return [...new Set(Object.values(visuals.captures).map((capture) => capture.file))];
}

function syncManualFiles(targetDir, visuals, checkOnly, errors) {
  const relativeFiles = [...staticFiles, ...visualAssetFiles(visuals)];
  for (const file of relativeFiles) {
    const source = join(repoRoot, "docs", "public", "manual", "shellx", file);
    const target = join(targetDir, file);
    if (checkOnly) compareCopiedFile(target, source, errors);
    else {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  }
}

function siteCardHtml() {
  return `          <!-- shellx-docs-card:begin -->
          <a class="docs-product docs-product--available docs-product--shellx" href="manual/shellx/">
            <span class="docs-product-icon" aria-hidden="true">
              <img src="manual/assets/icon.png" alt="" />
            </span>
            <span class="docs-product-copy">
              <strong>ShellX</strong>
              <span>Agents, Browser, and Vault</span>
            </span>
            <span class="docs-product-state">Open manual <span aria-hidden="true">&rarr;</span></span>
          </a>
          <!-- shellx-docs-card:end -->`;
}

function availableManualCount(source) {
  return (source.match(/<a\b[^>]*class="[^"]*\bdocs-product--available\b[^"]*"[^>]*>/g) ?? []).length;
}

function advertisedManualCount(source) {
  const matches = [...source.matchAll(/<span aria-hidden="true"><\/span>(\d+) manuals online/g)];
  if (matches.length !== 1) return null;
  return Number(matches[0][1]);
}

function updateSiteIndex(source) {
  let next = source.replace(
    /<meta name="robots" content="[^"]+" \/>/,
    '<meta name="robots" content="noindex,nofollow,noarchive" />',
  );
  const marked = /\s*<!-- shellx-docs-card:begin -->[\s\S]*?<!-- shellx-docs-card:end -->/;
  if (marked.test(next)) {
    next = next.replace(marked, `\n${siteCardHtml()}`);
  } else {
    const browserPlaceholder = /\s*<article class="docs-product docs-product--unavailable" aria-label="ShellX Browser manual coming later">[\s\S]*?<\/article>/;
    if (!browserPlaceholder.test(next)) {
      throw new Error("Docs-site index has neither the ShellX card markers nor the expected Browser placeholder.");
    }
    next = next.replace(browserPlaceholder, `\n${siteCardHtml()}`);
  }
  const count = availableManualCount(next);
  if (count <= 0 || advertisedManualCount(next) === null) {
    throw new Error("Docs-site index must contain exactly one manual count and at least one available manual card.");
  }
  return next.replace(
    /<span aria-hidden="true"><\/span>\d+ manuals online/,
    `<span aria-hidden="true"></span>${count} manuals online`,
  );
}

function siteRootArg(args) {
  const index = args.indexOf("--site-root");
  const explicit = index >= 0 ? args[index + 1] : undefined;
  const value = explicit || process.env.SHELLX_DOCS_SITE_ROOT;
  if (!value) throw new Error("Set SHELLX_DOCS_SITE_ROOT or pass --site-root <docs-site directory>.");
  return resolve(value);
}

function publicExportRootArg(args) {
  const index = args.indexOf("--public-export-root");
  const explicit = index >= 0 ? args[index + 1] : undefined;
  const value = explicit || process.env.SHELLX_PUBLIC_EXPORT_ROOT;
  if (!value) {
    throw new Error("Set SHELLX_PUBLIC_EXPORT_ROOT or pass --public-export-root <ShellX public-export checkout>.");
  }
  return resolve(value);
}

function validatePublicExportRoot(publicExportRoot, content) {
  const exportPackagePath = join(publicExportRoot, "package.json");
  if (!existsSync(exportPackagePath)) {
    throw new Error(`Public-export root is not a ShellX checkout; package.json is missing: ${publicExportRoot}`);
  }
  const exportPackage = readJsonFile(exportPackagePath, "public-export package metadata");
  if (exportPackage.name !== "shellx") {
    throw new Error(`Public-export package must be shellx, found ${exportPackage.name ?? "missing"}: ${publicExportRoot}`);
  }
  if (exportPackage.version !== content.version) {
    throw new Error(
      `Public-export version ${exportPackage.version ?? "missing"} does not match manual/source version ${content.version}. Stage the intended source candidate before synchronizing docs.`,
    );
  }
}

function syncPublicExport(publicExportRoot, html, markdown, content, visuals, checkOnly) {
  validatePublicExportRoot(publicExportRoot, content);
  const targetDir = join(publicExportRoot, "docs", "public", "manual", "shellx");
  const targets = [
    [join(publicExportRoot, "docs", "public", "SHELLX_MANUAL.md"), markdown],
    [join(targetDir, "content.json"), readFileSync(contentPath, "utf8")],
    [join(targetDir, "index.html"), html],
  ];
  const errors = [];
  if (checkOnly) {
    for (const [path, expected] of targets) compareGenerated(path, expected, errors);
    syncManualFiles(targetDir, visuals, true, errors);
    return errors;
  }
  for (const [path, body] of targets) writeGenerated(path, body);
  syncManualFiles(targetDir, visuals, false, errors);
  return errors;
}

function syncSite(siteRoot, html, visuals, checkOnly) {
  const targetDir = join(siteRoot, "manual", "shellx");
  const errors = [];
  if (checkOnly) {
    compareGenerated(join(targetDir, "index.html"), html, errors);
    syncManualFiles(targetDir, visuals, true, errors);
    const indexPath = join(siteRoot, "index.html");
    if (!existsSync(indexPath)) errors.push(`missing docs-site index: ${indexPath}`);
    else {
      const index = readFileSync(indexPath, "utf8");
      const availableCount = availableManualCount(index);
      const advertisedCount = advertisedManualCount(index);
      if (!index.includes("shellx-docs-card:begin")
        || availableCount <= 0
        || advertisedCount !== availableCount) {
        errors.push(`docs-site index does not advertise the ShellX manual: ${indexPath}`);
      }
      if (!index.includes('content="noindex,nofollow,noarchive"')) {
        errors.push(`docs-site index does not preserve tester-only indexing policy: ${indexPath}`);
      }
    }
    return errors;
  }

  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "index.html"), html, "utf8");
  syncManualFiles(targetDir, visuals, false, errors);
  const indexPath = join(siteRoot, "index.html");
  writeFileSync(indexPath, updateSiteIndex(readFileSync(indexPath, "utf8")), "utf8");
  return [];
}

function main() {
  const args = process.argv.slice(2);
  const content = readManualContent();
  const visuals = readManualVisuals(content);
  const html = renderHtml(content, visuals);
  const markdown = renderMarkdown(content);

  if (args.includes("--write-all") || args.includes("--check-all")) {
    const checkOnly = args.includes("--check-all");
    const siteRoot = siteRootArg(args);
    const publicExportRoot = publicExportRootArg(args);
    validatePublicExportRoot(publicExportRoot, content);
    const errors = [];
    if (checkOnly) {
      compareGenerated(htmlPath, html, errors);
      compareGenerated(markdownPath, markdown, errors);
    } else {
      writeGenerated(htmlPath, html);
      writeGenerated(markdownPath, markdown);
    }
    errors.push(...syncSite(siteRoot, html, visuals, checkOnly));
    errors.push(...syncPublicExport(publicExportRoot, html, markdown, content, visuals, checkOnly));
    if (errors.length > 0) throw new Error(errors.join("\n"));
    process.stdout.write(
      `${checkOnly ? "Checked" : "Synchronized"} ShellX documentation across repository, ${siteRoot}, and ${publicExportRoot}\n`,
    );
    return;
  }

  if (args.includes("--write")) {
    writeGenerated(htmlPath, html);
    writeGenerated(markdownPath, markdown);
    process.stdout.write(`Wrote ${htmlPath}\nWrote ${markdownPath}\n`);
    return;
  }

  if (args.includes("--check")) {
    const errors = [];
    compareGenerated(htmlPath, html, errors);
    compareGenerated(markdownPath, markdown, errors);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    process.stdout.write(`ShellX docs generated outputs match v${content.version} canonical content.\n`);
    return;
  }

  if (args.includes("--write-site") || args.includes("--check-site")) {
    const generatedErrors = [];
    compareGenerated(htmlPath, html, generatedErrors);
    compareGenerated(markdownPath, markdown, generatedErrors);
    if (generatedErrors.length > 0) throw new Error(generatedErrors.join("\n"));
    const siteRoot = siteRootArg(args);
    const errors = syncSite(siteRoot, html, visuals, args.includes("--check-site"));
    if (errors.length > 0) throw new Error(errors.join("\n"));
    process.stdout.write(`${args.includes("--check-site") ? "Checked" : "Synchronized"} ShellX manual at ${siteRoot}\n`);
    return;
  }

  throw new Error("Usage: node scripts/generate-shellx-docs.mjs --write|--check|--write-site|--check-site|--write-all|--check-all [--site-root <dir>] [--public-export-root <dir>]");
}

try {
  main();
} catch (error) {
  console.error(`ShellX docs: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
