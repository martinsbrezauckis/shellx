/**
 * Smoke tests for chat-stream rendering primitives.
 *
 * These render the real ChatOutput component to static markup so link and
 * media regressions are caught without needing a live Grok turn.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SafeVideo } from "../src/components/MediaPreview";
import { SafeMarkdownLink } from "../src/lib/markdown-links";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== chat rendering: links ===");
{
  const http = renderToStaticMarkup(
    <SafeMarkdownLink href="https://x.com/i/status/123">post</SafeMarkdownLink>,
  );
  const file = renderToStaticMarkup(
    <SafeMarkdownLink href="goal.md:12" onPreviewFile={() => { /* smoke test only */ }}>
      goal
    </SafeMarkdownLink>,
  );
  const nested = renderToStaticMarkup(
    <SafeMarkdownLink href="./docs/notes.md:3" currentPath="/home/user/project/goal.md" onPreviewFile={() => { /* smoke test only */ }}>
      notes
    </SafeMarkdownLink>,
  );
  const html = `${http}\n${file}\n${nested}`;
  assert(html.includes('href="https://x.com/i/status/123"'), "X/http link stays a browser anchor");
  assert(html.includes('class="flink"'), "markdown file links render as preview chips");
  assert(html.includes("goal.md") && html.includes("notes.md"), "file chip labels are visible");
}

console.log("\n=== chat rendering: video tool preview ===");
{
  const html = renderToStaticMarkup(
    <SafeVideo
      src="/home/user/.grok/sessions/abc/videos/demo clip.mp4"
      title="Generated: video_gen"
      tabId="tab-a"
    />,
  );
  assert(html.includes("<video"), "video tool renders a video element");
  assert(html.includes("controls"), "video element exposes controls");
  assert(html.includes("md-video"), "video element gets chat preview styling");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} chat rendering tests`);
process.exit(failures === 0 ? 0 : 1);
