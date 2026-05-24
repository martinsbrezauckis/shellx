import { groupEvents } from "../src/lib/grouping";
import { extractSessionMedia } from "../src/lib/session-media";
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

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== session media extraction ===");

const imgPath = "/home/user/.grok/sessions/abc/images/result one.jpg";
const vidPath = "C:\\Users\\User\\.grok\\sessions\\abc\\videos\\clip one.mp4";
const events: RawEventFrame[] = [
  toolOpen("img-a", "image_gen", 100),
  toolUpdate("img-a", "image_gen", `Successfully generated image and saved to ${imgPath}`, 101),
  toolOpen("img-b", "image_gen", 102),
  toolUpdate("img-b", "image_gen", `Duplicate output ${imgPath}`, 103),
  toolOpen("vid-a", "video_gen", 110),
  toolUpdate("vid-a", "video_gen", `Preview: [clip](${vidPath})`, 111),
];

const media = extractSessionMedia(groupEvents(events));
assert(media.images.length === 1, "deduplicates repeated image output paths");
assert(media.images[0]?.path === imgPath, "extracts image path with spaces");
assert(media.images[0]?.title === "result one.jpg", "uses filename as image title");
assert(media.videos.length === 1, "extracts one video item");
assert(media.videos[0]?.path === vidPath, "extracts Windows video path with spaces");
assert(media.videos[0]?.toolTitle === "video_gen", "keeps source tool title");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} session media tests`);
process.exit(failures === 0 ? 0 : 1);
