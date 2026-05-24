import { groupEvents } from "../src/lib/grouping";
import type { RawEventFrame } from "../src/types/acp";

const makeToolCallOpen = (toolName: string, idSuffix: string): RawEventFrame => ({
  t: Date.now(),
  kind: "grok-acp-event",
  payload: {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `tool-${idSuffix}`,
        title: toolName,
        kind: "Other",
        status: "InProgress",
      },
    },
  },
});

const makeToolUpdate = (toolName: string, text: string, idSuffix: string): RawEventFrame => ({
  t: Date.now(),
  kind: "grok-acp-event",
  payload: {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: `tool-${idSuffix}`,
        title: toolName,
        kind: "Other",
        status: "Completed",
        rawOutput: { type: "Text", text },
      },
    },
  },
});

// Replay scenarios
const cases = [
  {
    name: "image_gen WSL Linux path",
    text: "Successfully generated image and saved to /home/user/.grok/sessions/abc/images/1.jpg (aspect_ratio=16:9, 207227 bytes).",
    expectImage: "/home/user/.grok/sessions/abc/images/1.jpg",
    expectVideo: undefined,
    tool: "image_gen",
    id: "img1",
  },
  {
    name: "image_gen WSL encoded cwd path",
    text: "Successfully generated image and saved to /home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject/019abc/images/1.jpg.",
    expectImage: "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject/019abc/images/1.jpg",
    expectVideo: undefined,
    tool: "image_gen",
    id: "img1b",
  },
  {
    name: "image_gen WSL UNC path",
    text: "Saved image at \\\\wsl$\\Ubuntu-24.04\\home\\user\\.grok\\sessions\\%2Fhome%2Fuser%2Fproject\\019abc\\images\\1.jpg",
    expectImage: "\\\\wsl$\\Ubuntu-24.04\\home\\user\\.grok\\sessions\\%2Fhome%2Fuser%2Fproject\\019abc\\images\\1.jpg",
    expectVideo: undefined,
    tool: "image_gen",
    id: "img1c",
  },
  {
    name: "image_gen SSH remote path",
    text: "Generated image saved at /home/deploy/.grok/sessions/%2Fsrv%2Fapp/019ssh/images/1.png.",
    expectImage: "/home/deploy/.grok/sessions/%2Fsrv%2Fapp/019ssh/images/1.png",
    expectVideo: undefined,
    tool: "image_gen",
    id: "img1d",
  },
  {
    name: "image_gen Windows path",
    text: "Successfully generated image and saved to C:\\Users\\User\\.grok\\sessions\\019xyz\\images\\2.png (1080x1920).",
    expectImage: "C:\\Users\\User\\.grok\\sessions\\019xyz\\images\\2.png",
    expectVideo: undefined,
    tool: "image_gen",
    id: "img2",
  },
  {
    name: "image_gen Windows extended-length path",
    text: "Image generated and saved to \\\\?\\C:\\Users\\User\\.grok\\sessions\\C%3A%5CUsers%5CUser\\019xyz\\images\\1.jpg.",
    expectImage: "C:\\Users\\User\\.grok\\sessions\\C%3A%5CUsers%5CUser\\019xyz\\images\\1.jpg",
    expectVideo: undefined,
    tool: "image_gen",
    id: "img2x",
  },
  {
    name: "video_gen WSL path mp4",
    text: "Generated video saved at /home/user/.grok/sessions/abc/videos/1.mp4 (5 sec, 16:9).",
    expectImage: undefined,
    expectVideo: "/home/user/.grok/sessions/abc/videos/1.mp4",
    tool: "video_gen",
    id: "vid1",
  },
  {
    name: "video_gen SSH remote path",
    text: "Generated video saved at /home/deploy/.grok/sessions/%2Fsrv%2Fapp/019ssh/videos/1.mp4.",
    expectImage: undefined,
    expectVideo: "/home/deploy/.grok/sessions/%2Fsrv%2Fapp/019ssh/videos/1.mp4",
    tool: "video_gen",
    id: "vid1b",
  },
  {
    name: "video_gen Windows path webm",
    text: "Saved to C:\\Users\\User\\.grok\\sessions\\019xyz\\videos\\2.webm",
    expectImage: undefined,
    expectVideo: "C:\\Users\\User\\.grok\\sessions\\019xyz\\videos\\2.webm",
    tool: "video_gen",
    id: "vid2",
  },
  {
    name: "video_gen Windows extended-length path",
    text: "Video generated and saved to \\\\?\\C:\\Users\\User\\.grok\\sessions\\C%3A%5CUsers%5CUser\\019xyz\\videos\\1.mp4.",
    expectImage: undefined,
    expectVideo: "C:\\Users\\User\\.grok\\sessions\\C%3A%5CUsers%5CUser\\019xyz\\videos\\1.mp4",
    tool: "video_gen",
    id: "vid2x",
  },
  {
    name: "video_gen raw html src with spaces",
    text: '<video controls src="/home/user/.grok/sessions/abc/videos/demo clip.mp4"></video>',
    expectImage: undefined,
    expectVideo: "/home/user/.grok/sessions/abc/videos/demo clip.mp4",
    tool: "video_gen",
    id: "vid3",
  },
  {
    name: "video_gen markdown link Windows path with spaces",
    text: "Preview: [clip](C:\\Users\\User\\.grok\\sessions\\019xyz\\videos\\demo clip.mov)",
    expectImage: undefined,
    expectVideo: "C:\\Users\\User\\.grok\\sessions\\019xyz\\videos\\demo clip.mov",
    tool: "video_gen",
    id: "vid4",
  },
  {
    name: "video_gen markdown link path with parentheses",
    text: "Preview: [clip](/home/user/.grok/sessions/abc/videos/demo (final).mp4)",
    expectImage: undefined,
    expectVideo: "/home/user/.grok/sessions/abc/videos/demo (final).mp4",
    tool: "video_gen",
    id: "vid5",
  },
  {
    name: "image_gen text path with parentheses",
    text: "Saved to /home/user/.grok/sessions/abc/images/mockup (1).png",
    expectImage: "/home/user/.grok/sessions/abc/images/mockup (1).png",
    expectVideo: undefined,
    tool: "image_gen",
    id: "img3",
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  // Real grok wire: tool_call OPEN, then tool_call_update.
  const open = makeToolCallOpen(c.tool, c.id);
  const ev = makeToolUpdate(c.tool, c.text, c.id);
  const groups = groupEvents([open, ev]);
  const tg = groups.find((g) => g.kind === "tool") as any;
  if (!tg) { console.log("FAIL", c.name, "no tool group"); fail++; continue; }
  const img = tg.imagePath, vid = tg.videoPath;
  const ok = img === c.expectImage && vid === c.expectVideo;
  console.log((ok ? "PASS" : "FAIL"), c.name, "img:", img ?? "—", "vid:", vid ?? "—");
  ok ? pass++ : fail++;
}
console.log(`\n${pass}/${pass+fail} cases pass`);
process.exit(fail > 0 ? 1 : 0);
