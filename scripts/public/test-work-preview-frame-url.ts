import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkPreviewStage } from "../../src/components/WorkPreviewPanel";
import { emptyWorkPreviewState } from "../../src/lib/work-preview";

function iframeSrc(url: string, revision: number): string {
  const state = {
    ...emptyWorkPreviewState("preview-tab"),
    kind: "webApp" as const,
    status: "running" as const,
    url,
    startedAtMs: revision,
    updatedAtMs: revision,
  };
  const markup = renderToStaticMarkup(React.createElement(WorkPreviewStage, { state }));
  const src = markup.match(/<iframe\b[^>]*\bsrc="([^"]+)"/)?.[1];
  assert.ok(src, "running Work Preview renders an iframe");
  return src.replaceAll("&amp;", "&");
}

const rootUrl = "http://127.0.0.1:54321/";
assert.equal(iframeSrc(rootUrl, 1), rootUrl, "query-sensitive dev servers receive their original root URL");
assert.equal(iframeSrc(rootUrl, 2), rootUrl, "new preview generation keeps the server URL unchanged");

const routedUrl = "http://127.0.0.1:54321/app?mode=preview#section";
assert.equal(iframeSrc(routedUrl, 3), routedUrl, "app query and hash route survive the embed");

console.log("Work Preview iframe URL contract passed");
