import {
  extractSessionAssetRegistry,
  splitAssetsByActiveTab,
} from "../src/lib/session-assets";
import type { RawEventFrame } from "../src/types/acp";

function toolOpen(tabId: string, sessionId: string, toolCallId: string, title: string, t: number): RawEventFrame {
  return {
    t,
    kind: "grok-acp-event",
    payload: {
      _meta: { tabId },
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        _meta: { tabId },
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title,
          kind: "Other",
          status: "InProgress",
        },
      },
    },
  };
}

function toolUpdate(tabId: string, sessionId: string, toolCallId: string, title: string, text: string, t: number): RawEventFrame {
  return {
    t,
    kind: "grok-acp-event",
    payload: {
      _meta: { tabId },
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        _meta: { tabId },
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          title,
          kind: "Other",
          status: "Completed",
          rawOutput: { type: "Text", text },
        },
      },
    },
  };
}

function providerEvent(tabId: string, runId: string, providerId: string, kind: string, text: string, t: number): RawEventFrame {
  return {
    t,
    kind: "provider-session-event",
    payload: {
      _meta: { tabId },
      tabId,
      runId,
      providerId,
      kind,
      text,
    },
  };
}

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== session asset registry ===");

const tabA = {
  tabId: "tab-a",
  sessionId: "sid-a",
  title: "Grok image work",
  cwd: "C:\\Users\\FixtureUser\\project-a",
  connectionLabel: "Local",
  connectionTransport: "local",
};
const tabB = {
  tabId: "tab-b",
  sessionId: "sid-b",
  title: "WSL media",
  cwd: "/home/user/project-b",
  connectionLabel: "Ubuntu",
  connectionTransport: "wsl",
};
const tabC = {
  tabId: "tab-c",
  sessionId: "provider-run",
  title: "Codex media",
  cwd: "/home/user/project-c",
  connectionLabel: "Ubuntu",
  connectionTransport: "wsl",
};

const imgA = "C:\\Users\\FixtureUser\\.grok\\sessions\\C%3A%5CUsers%5CFixtureUser%5Cproject-a\\sid-a\\images\\1.png";
const vidB = "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject-b/sid-b/videos/1.mp4";
const providerImgC = "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject-c/sid-c/images/provider.png";
const providerSplitImgC = "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject-c/sid-c/images/provider-split.png";
const providerCopiedCodexC = "/home/user/project-c/mountain_lake_sunrise.png";
const providerCodexGeneratedC = "/home/user/.codex/generated_images/019e9816-8701-74b0-bcd4-7e3b218171a7/ig_0931eb331b49f8c8016a22d6c0b7dc81938fff5bf643c40f89.png";
const providerCopiedCodexCommandC = "/home/user/project-c/gpt-image-codex.png";
const providerCodexCommandOriginalC = "/home/user/.codex/generated_images/019e984f-2fb2-7683-8d53-e9c642bef1ec/ig_03724ec19d7b26fb016a22e55b16988191ae87bd544923af0e.png";
const providerInlineCodeImageC = "/home/user/project-c/output-inline.png";

const events: RawEventFrame[] = [
  toolOpen("tab-a", "sid-a", "img-a", "image_gen", 100),
  toolUpdate("tab-a", "sid-a", "img-a", "image_gen", `Image generated and saved to ${imgA}.`, 101),
  toolOpen("tab-b", "sid-b", "vid-b", "video_gen", 200),
  toolUpdate("tab-b", "sid-b", "vid-b", "video_gen", `Video generated and saved to ${vidB}.`, 201),
  providerEvent("tab-c", "provider-run", "codex-cli", "text", `Generated image saved to ${providerImgC}.`, 250),
  providerEvent("tab-c", "provider-run-copied-codex", "codex-cli", "text", providerCopiedCodexC, 251),
  providerEvent("tab-c", "provider-run-codex-original", "codex-cli", "text", `Original GPT Image output: ${providerCodexGeneratedC}`, 252),
  providerEvent("tab-c", "provider-run-inline-code", "codex-cli", "text", `Saved image to \`${providerInlineCodeImageC}\``, 252.5),
  providerEvent(
    "tab-c",
    "provider-run-command-fragment",
    "codex-cli",
    "text",
    `mkdir -p /home/user/project-c && rm -f ${providerCopiedCodexCommandC} && cp ${providerCodexCommandOriginalC} ${providerCopiedCodexCommandC}`,
    253,
  ),
  providerEvent("tab-c", "provider-run-command-result", "codex-cli", "text", `GPT_IMAGE_RESULT path=${providerCopiedCodexCommandC} bytes=1642132`, 254),
  providerEvent(
    "tab-c",
    "provider-run-claude-ghosts",
    "claude-code",
    "text",
    "| Grok Imagine | `~/.grok/sessions/%2Fhome%2Fuser%2Fproject-c/sid-c/images/1.jpg` |\n| GPT Image | `/.codex/generated_images/019e9816/ig_ghost.png` | `~/.grok/sessions/%2Fhome%2Fuser%2Fproject-c/sid-c/images/1.jpg` |",
    255,
  ),
  providerEvent("tab-c", "provider-run-split", "claude-code", "textDelta", "Generated image saved to /home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject-c/sid-c/images/provider-", 260),
  providerEvent("tab-c", "provider-run-split", "claude-code", "textDelta", "split.png", 261),
  toolOpen("tab-closed", "sid-x", "img-x", "image_gen", 300),
  toolUpdate("tab-closed", "sid-x", "img-x", "image_gen", "Image generated and saved to /home/user/.grok/sessions/x/images/1.png.", 301),
];

const registry = extractSessionAssetRegistry(events, [tabA, tabB, tabC]);
assert(registry.images.length === 8, "indexes image assets from open tabs");
assert(registry.videos.length === 1, "indexes video assets from open tabs");
assert(registry.all.length === 9, "combines image and video assets");
assert(registry.images.some((asset) => asset.path === imgA), "keeps encoded Grok image path intact");
assert(registry.images.some((asset) => asset.path === providerImgC), "indexes provider text image assets");
assert(registry.images.some((asset) => asset.path === providerCopiedCodexC), "indexes standalone copied provider image assets");
assert(registry.images.some((asset) => asset.path === providerCodexGeneratedC), "indexes Codex generated_images provider assets");
assert(registry.images.some((asset) => asset.path === providerInlineCodeImageC), "indexes inline-code provider media paths");
assert(registry.images.some((asset) => asset.path === providerCopiedCodexCommandC), "indexes copied GPT Image result path from provider text");
assert(registry.images.some((asset) => asset.path === providerCodexCommandOriginalC), "indexes Codex generated_images command source path");
assert(registry.images.some((asset) => asset.path === providerSplitImgC), "indexes provider text image assets split across deltas");
assert(!registry.images.some((asset) => asset.path === "/images/1.jpg"), "does not index root-only Grok image ghosts");
assert(!registry.images.some((asset) => asset.path.startsWith("/.codex/")), "does not index root-only Codex image ghosts");
assert(!registry.images.some((asset) => asset.path.includes("|") || asset.path.includes("`")), "does not index markdown table fragments");
assert(!registry.images.some((asset) => asset.path.includes("&&") || /\brm -f\b/.test(asset.path)), "does not index shell command fragments as image paths");
assert(registry.images.some((asset) => asset.sourceTabId === "tab-a"), "records source tab id");
assert(registry.images.find((asset) => asset.sourceTabId === "tab-a")?.sourceSessionId === "sid-a", "records source session id");
assert(registry.images.find((asset) => asset.sourceTabId === "tab-a")?.sourceCwd === tabA.cwd, "records source cwd");
assert(registry.videos[0]?.sourceTransport === "wsl", "records source transport");
assert(registry.images.find((asset) => asset.sourceTabId === "tab-c")?.sourceTransport === "wsl", "records source transport for provider WSL tab");
assert(!registry.all.some((asset) => asset.sourceTabId === "tab-closed"), "drops events from unknown closed tabs");

const split = splitAssetsByActiveTab(registry.all, "tab-a");
assert(split.current.length === 1 && split.current[0]?.sourceTabId === "tab-a", "splits active-tab assets");
assert(split.other.length === 8 && split.other.some((asset) => asset.sourceTabId === "tab-b") && split.other.some((asset) => asset.sourceTabId === "tab-c"), "splits other-tab assets for cross-provider reuse");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} session asset registry tests`);
process.exit(failures === 0 ? 0 : 1);
