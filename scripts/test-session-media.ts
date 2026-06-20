import { groupEvents } from "../src/lib/grouping";
import { extractGeneratedMediaPath } from "../src/lib/media-paths";
import { extractSessionAttachments, extractSessionMedia } from "../src/lib/session-media";
import type { RawEventFrame } from "../src/types/acp";

function toolOpen(id: string, title: string, t: number): RawEventFrame {
  return {
    t,
    kind: "grok-acp-event",
    payload: {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: id,
          title,
          kind: "Other",
          status: "InProgress",
        },
      },
    },
  };
}

function toolUpdate(id: string, title: string, text: string, t: number): RawEventFrame {
  return {
    t,
    kind: "grok-acp-event",
    payload: {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          title,
          kind: "Other",
          status: "Completed",
          rawOutput: { type: "Text", text },
        },
      },
    },
  };
}

function toolPathUpdate(id: string, title: string, path: string, mediaType: string, t: number): RawEventFrame {
  return {
    t,
    kind: "grok-acp-event",
    payload: {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          title,
          kind: "Other",
          status: "Completed",
          path,
          type: mediaType,
        },
      },
    },
  };
}

function providerEvent(
  tabId: string,
  runId: string,
  providerId: "codex-cli" | "claude-code",
  kind: string,
  text: string,
  t: number,
): RawEventFrame {
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

console.log("\n=== session media extraction ===");

const imgPath = "/home/user/.grok/sessions/abc/images/result one.jpg";
const wslEncodedImgPath = "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject/abc/images/result-three.jpg";
const sshVidPath = "/home/deploy/.grok/sessions/%2Fsrv%2Fapp/abc/videos/clip-ssh.mp4";
const vidPath = "C:\\Users\\FixtureUser\\.grok\\sessions\\abc\\videos\\clip one.mp4";
const extendedImgPath = "C:\\Users\\FixtureUser\\.grok\\sessions\\C%3A%5CUsers%5CFixtureUser\\abc\\images\\result-two.jpg";
const extendedVidPath = "C:\\Users\\FixtureUser\\.grok\\sessions\\C%3A%5CUsers%5CFixtureUser\\abc\\videos\\clip-two.mp4";
const pathFieldImgPath = "C:\\Users\\FixtureUser\\.grok\\sessions\\C%3A%5CUsers%5CFixtureUser\\abc\\images\\path-field.jpg";
const providerImgPath = "C:\\Users\\FixtureUser\\.grok\\sessions\\C%3A%5CUsers%5CFixtureUser%5CDownloads\\sid\\images\\provider.png";
const providerSplitImgPath = "C:\\Users\\FixtureUser\\.grok\\sessions\\C%3A%5CUsers%5CFixtureUser%5CDownloads\\sid\\images\\provider-split.png";
const providerVidPath = "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject/sid/videos/provider.mp4";
const providerCopiedCodexImgPath = "/home/user/mountain_lake_sunrise.png";
const providerCodexGeneratedImgPath = "/home/user/.codex/generated_images/019e9816-8701-74b0-bcd4-7e3b218171a7/ig_0931eb331b49f8c8016a22d6c0b7dc81938fff5bf643c40f89.png";
const events: RawEventFrame[] = [
  toolOpen("img-a", "image_gen", 100),
  toolUpdate("img-a", "image_gen", `Successfully generated image and saved to ${imgPath}`, 101),
  toolOpen("img-b", "image_gen", 102),
  toolUpdate("img-b", "image_gen", `Duplicate output ${imgPath}`, 103),
  toolOpen("img-c", "image_gen", 104),
  toolUpdate("img-c", "image_gen", "Image generated and saved to \\\\?\\C:\\Users\\FixtureUser\\.grok\\sessions\\C%3A%5CUsers%5CFixtureUser\\abc\\images\\result-two.jpg.", 105),
  toolOpen("img-d", "image_gen", 106),
  toolUpdate("img-d", "image_gen", `WSL generated image saved to ${wslEncodedImgPath}`, 107),
  toolOpen("img-e", "image_gen", 108),
  toolPathUpdate("img-e", "image_gen", "\\\\?\\C:\\Users\\FixtureUser\\.grok\\sessions\\C%3A%5CUsers%5CFixtureUser\\abc\\images\\path-field.jpg", "ImageGen", 109),
  toolOpen("vid-a", "video_gen", 110),
  toolUpdate("vid-a", "video_gen", `Preview: [clip](${vidPath})`, 111),
  toolOpen("vid-b", "video_gen", 112),
  toolUpdate("vid-b", "video_gen", "Video generated and saved to \\\\?\\C:\\Users\\FixtureUser\\.grok\\sessions\\C%3A%5CUsers%5CFixtureUser\\abc\\videos\\clip-two.mp4.", 113),
  toolOpen("vid-c", "video_gen", 114),
  toolUpdate("vid-c", "video_gen", `SSH generated video saved to ${sshVidPath}`, 115),
  toolOpen("vision-a", "vision_describe", 116),
  toolUpdate("vision-a", "vision_describe", "Path must end in .png/.jpg/.jpeg/.webp/.gif/.bmp.", 117),
  toolOpen("grep-ghost", "Execute grep media paths", 117.5),
  toolUpdate(
    "grep-ghost",
    "Execute grep media paths",
    "grep -n 'send_prompt_to_provider\\|Provider session\\|blue rocket\\|\\.png\\|images/generations' updates.jsonl",
    117.6,
  ),
  providerEvent("tab-provider", "run-codex", "codex-cli", "text", `Generated image saved to ${providerImgPath}.`, 118),
  providerEvent("tab-provider", "run-codex-copy", "codex-cli", "text", providerCopiedCodexImgPath, 118.1),
  providerEvent(
    "tab-provider",
    "run-codex-original",
    "codex-cli",
    "text",
    `Original GPT Image output: ${providerCodexGeneratedImgPath}`,
    118.2,
  ),
  providerEvent(
    "tab-provider",
    "run-claude-table-ghost",
    "claude-code",
    "text",
    "| Grok Imagine | `~/.grok/sessions/%2Fhome%2Fuser/019e9816-8ed4-78d2-adf1-a1a123f5c882/images/1.jpg` |\n| GPT Image | `/.codex/generated_images/019e9816-8701-74b0-bcd4-7e3b218171a7/ig_0931eb331b49f8c8016a22d6c0b7dc81938fff5bf643c40f89.png` | `~/.grok/sessions/%2Fhome%2Fuser/019e9816-8ed4-78d2-adf1-a1a123f5c882/images/1.jpg` |",
    118.3,
  ),
  providerEvent(
    "tab-provider",
    "run-codex",
    "codex-cli",
    "command",
    'cp /tmp/generated.png "C:\\Users\\FixtureUser\\Downloads\\codex-image-smoke-${stamp}.png"',
    118.5,
  ),
  providerEvent("tab-provider", "run-claude", "claude-code", "textDelta", `Preview video: ${providerVidPath}`, 119),
  providerEvent("tab-provider", "run-claude-split", "claude-code", "textDelta", "Generated image saved to C:\\Users\\FixtureUser\\.grok\\sessions\\C%3A%5CUsers%5CFixtureUser%5CDownloads\\sid\\images\\provider-", 120),
  providerEvent("tab-provider", "run-claude-split", "claude-code", "textDelta", "split.png", 121),
  {
    t: 122,
    kind: "ui",
    payload: {
      text: "→ prompt: Please inspect this",
      attachments: [
        { path: "C:\\Users\\FixtureUser\\Downloads\\expo preview.png", label: "expo preview.png", kind: "image" },
      ],
    },
  },
];

const media = extractSessionMedia(groupEvents(events));
assert(media.images.length === 8, "deduplicates repeated image output paths and keeps distinct images");
assert(media.images[0]?.path === imgPath, "extracts image path with spaces");
assert(media.images[0]?.title === "result one.jpg", "uses filename as image title");
assert(media.images.some((item) => item.path === extendedImgPath), "normalizes Windows extended-length image paths");
assert(media.images.some((item) => item.path === wslEncodedImgPath), "keeps WSL encoded cwd image paths intact");
assert(media.images.some((item) => item.path === pathFieldImgPath), "extracts Grok ImageGen top-level path fields");
assert(media.images.some((item) => item.path === providerImgPath), "extracts provider text image paths");
assert(media.images.some((item) => item.path === providerCopiedCodexImgPath), "extracts standalone provider copied image paths");
assert(media.images.some((item) => item.path === providerCodexGeneratedImgPath), "extracts provider Codex generated_images paths");
assert(media.images.some((item) => item.path === providerSplitImgPath), "extracts provider image paths split across text deltas");
assert(!media.images.some((item) => item.path.includes("${stamp}")), "ignores provider command-line template image paths");
assert(!media.images.some((item) => item.path.includes("Provider session")), "ignores grep regex alternation patterns that mention media extensions");
assert(!media.images.some((item) => item.path === "/images/1.jpg"), "does not create root-only Grok image ghosts from tilde paths");
assert(!media.images.some((item) => item.path.includes("|") || item.path.includes("`")), "does not create table-fragment image ghosts");
assert(!media.images.some((item) => item.path.startsWith("/.codex/")), "does not create root-only Codex image ghosts");
assert(
  extractGeneratedMediaPath(
    "grep -n 'send_prompt_to_provider\\|Provider session\\|blue rocket\\|\\.png\\|images/generations' updates.jsonl",
    "image",
  ) === undefined,
  "media path parser ignores regex alternation patterns that mention extensions",
);
assert(
  extractGeneratedMediaPath(
    "| GPT Image | `/.codex/generated_images/019e9816/ig_0931eb331b49f8c8016a22d6c0b7dc81938fff5bf643c40f89.png` | `~/.grok/sessions/019e9816/images/1.jpg` |",
    "image",
  ) === undefined,
  "media path parser ignores root-only markdown table ghosts",
);
assert(media.videos.length === 4, "extracts video items");
assert(media.videos[0]?.path === vidPath, "extracts Windows video path with spaces");
assert(media.videos[0]?.toolTitle === "video_gen", "keeps source tool title");
assert(media.videos.some((item) => item.path === extendedVidPath), "normalizes Windows extended-length video paths");
assert(media.videos.some((item) => item.path === sshVidPath), "extracts SSH remote generated video paths");
assert(media.videos.some((item) => item.path === providerVidPath), "extracts provider text video paths");
assert(!media.images.some((item) => item.path.endsWith(".bmp")), "does not treat vision_describe docs as generated images");

const attachments = extractSessionAttachments(groupEvents(events));
assert(attachments.length === 1, "extracts sent attachment chips from UI echo");
assert(attachments[0]?.path === "C:\\Users\\FixtureUser\\Downloads\\expo preview.png", "keeps sent attachment path");
assert(attachments[0]?.kind === "image", "keeps sent attachment kind");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} session media tests`);
process.exit(failures === 0 ? 0 : 1);
