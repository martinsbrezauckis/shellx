import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const traversal = source("src-tauri/src/shellx_browser_dom_traversal.rs");
const identity = source("src-tauri/src/shellx_browser_element_identity.rs");
const actionability = source("src-tauri/src/shellx_browser_actionability.rs");
const scripts = source("src-tauri/src/shellx_browser_scripts.rs");
const actionScript = source("src-tauri/src/shellx_browser_action_script.rs");
const targets = source("src-tauri/src/shellx_browser_element_targets.rs");
const model = source("src-tauri/src/shellx_browser_observation_model.rs");
const metadata = source("src-tauri/src/build_metadata.rs");
const docs = source("docs/public/API.md");
const live = source("scripts/test-shellx-browser-stable-refs-live.ts");

assert(
  traversal.includes("SHELLX_DOM_MAX_ROOTS = 32")
    && traversal.includes("SHELLX_DOM_MAX_NODES = 12000")
    && traversal.includes("SHELLX_DOM_MAX_FRAME_DEPTH = 4")
    && traversal.includes("SHELLX_DOM_MAX_SHADOW_DEPTH = 8"),
  "nested DOM discovery has explicit root, node, frame, and shadow bounds",
);
assert(
  traversal.includes("frameOrigin === location.origin")
    && traversal.includes('href === "about:blank" || href === "about:srcdoc"')
    && traversal.includes("element.shadowRoot"),
  "discovery enters same-origin frames and open shadow roots only",
);
assert(
  traversal.includes("shellxDomLocatorFor")
    && traversal.includes("shellxResolveDomLocator")
    && actionScript.includes("BROWSER_DOM_TRAVERSAL_SCRIPT")
    && scripts.includes("if (request.locator) return shellxResolveDomLocator(request.locator)"),
  "observed nested refs resolve through an injected internal locator",
);
assert(
  model.includes("skip_serializing")
    && model.includes("pub raw_locator: Option<String>")
    && targets.includes("locator: candidate.raw_locator.clone()"),
  "nested locators remain internal and are recovered only from the observation cache",
);
assert(
  identity.includes('parts.unshift("::frame")')
    && identity.includes("shellxElementFrameUrl(element)")
    && scripts.includes("shellxElementFrameId(element)"),
  "ref identity distinguishes frame scopes and reports the owning frame",
);
assert(
  actionability.includes("shellxElementIsAttached")
    && actionability.includes("shellxDeepElementFromPoint")
    && actionability.includes("shellxGlobalRectFor(element)"),
  "nested actionability uses owner-document hit testing and top-viewport bounds",
);
assert(
  model.includes("same_origin_frames")
    && model.includes("cross_origin_frames")
    && model.includes("open_shadow_roots")
    && model.includes("traversal_truncated"),
  "DOM summaries expose traversal coverage and truncation",
);
assert(metadata.includes('"scopedDomTraversal"'), "Browser discovery advertises scoped DOM traversal");
assert(
  docs.includes("same-origin frames")
    && docs.includes("open shadow roots")
    && docs.includes("cross-origin frames"),
  "agent documentation defines nested DOM support and its boundary",
);
assert(
  live.includes("same-origin frame ref is actionable")
    && live.includes("open shadow ref is actionable")
    && live.includes("cross-origin frame is counted but not traversed"),
  "native smoke covers frame, shadow, and cross-origin behavior",
);

console.log("ShellX Browser scoped-DOM contract tests passed");
