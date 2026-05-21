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
    name: "image_gen Windows path",
    text: "Successfully generated image and saved to C:\\Users\\User\\.grok\\sessions\\019xyz\\images\\2.png (1080x1920).",
    expectImage: "C:\\Users\\User\\.grok\\sessions\\019xyz\\images\\2.png",
    expectVideo: undefined,
    tool: "image_gen",
    id: "img2",
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
    name: "video_gen Windows path webm",
    text: "Saved to C:\\Users\\User\\.grok\\sessions\\019xyz\\videos\\2.webm",
    expectImage: undefined,
    expectVideo: "C:\\Users\\User\\.grok\\sessions\\019xyz\\videos\\2.webm",
    tool: "video_gen",
    id: "vid2",
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
