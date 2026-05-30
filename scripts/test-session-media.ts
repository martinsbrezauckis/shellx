import { groupEvents } from "../src/lib/grouping";
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

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== session media extraction ===");

const imgPath = "/home/user/.grok/sessions/abc/images/result one.jpg";
const wslEncodedImgPath = "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject/abc/images/result-three.jpg";
const sshVidPath = "/home/deploy/.grok/sessions/%2Fsrv%2Fapp/abc/videos/clip-ssh.mp4";
const vidPath = "C:\\Users\\User\\.grok\\sessions\\abc\\videos\\clip one.mp4";
const extendedImgPath = "C:\\Users\\User\\.grok\\sessions\\C%3A%5CUsers%5CUser\\abc\\images\\result-two.jpg";
const extendedVidPath = "C:\\Users\\User\\.grok\\sessions\\C%3A%5CUsers%5CUser\\abc\\videos\\clip-two.mp4";
const events: RawEventFrame[] = [
  toolOpen("img-a", "image_gen", 100),
  toolUpdate("img-a", "image_gen", `Successfully generated image and saved to ${imgPath}`, 101),
  toolOpen("img-b", "image_gen", 102),
  toolUpdate("img-b", "image_gen", `Duplicate output ${imgPath}`, 103),
  toolOpen("img-c", "image_gen", 104),
  toolUpdate("img-c", "image_gen", "Image generated and saved to \\\\?\\C:\\Users\\User\\.grok\\sessions\\C%3A%5CUsers%5CUser\\abc\\images\\result-two.jpg.", 105),
  toolOpen("img-d", "image_gen", 106),
  toolUpdate("img-d", "image_gen", `WSL generated image saved to ${wslEncodedImgPath}`, 107),
  toolOpen("vid-a", "video_gen", 110),
  toolUpdate("vid-a", "video_gen", `Preview: [clip](${vidPath})`, 111),
  toolOpen("vid-b", "video_gen", 112),
  toolUpdate("vid-b", "video_gen", "Video generated and saved to \\\\?\\C:\\Users\\User\\.grok\\sessions\\C%3A%5CUsers%5CUser\\abc\\videos\\clip-two.mp4.", 113),
  toolOpen("vid-c", "video_gen", 114),
  toolUpdate("vid-c", "video_gen", `SSH generated video saved to ${sshVidPath}`, 115),
  toolOpen("vision-a", "vision_describe", 116),
  toolUpdate("vision-a", "vision_describe", "Path must end in .png/.jpg/.jpeg/.webp/.gif/.bmp.", 117),
  {
    t: 118,
    kind: "ui",
    payload: {
      text: "→ prompt: Please inspect this",
      attachments: [
        { path: "C:\\Users\\User\\Downloads\\expo preview.png", label: "expo preview.png", kind: "image" },
      ],
    },
  },
];

const media = extractSessionMedia(groupEvents(events));
assert(media.images.length === 3, "deduplicates repeated image output paths and keeps distinct images");
assert(media.images[0]?.path === imgPath, "extracts image path with spaces");
assert(media.images[0]?.title === "result one.jpg", "uses filename as image title");
assert(media.images.some((item) => item.path === extendedImgPath), "normalizes Windows extended-length image paths");
assert(media.images.some((item) => item.path === wslEncodedImgPath), "keeps WSL encoded cwd image paths intact");
assert(media.videos.length === 3, "extracts video items");
assert(media.videos[0]?.path === vidPath, "extracts Windows video path with spaces");
assert(media.videos[0]?.toolTitle === "video_gen", "keeps source tool title");
assert(media.videos.some((item) => item.path === extendedVidPath), "normalizes Windows extended-length video paths");
assert(media.videos.some((item) => item.path === sshVidPath), "extracts SSH remote generated video paths");
assert(!media.images.some((item) => item.path.endsWith(".bmp")), "does not treat vision_describe docs as generated images");

const attachments = extractSessionAttachments(groupEvents(events));
assert(attachments.length === 1, "extracts sent attachment chips from UI echo");
assert(attachments[0]?.path === "C:\\Users\\User\\Downloads\\expo preview.png", "keeps sent attachment path");
assert(attachments[0]?.kind === "image", "keeps sent attachment kind");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} session media tests`);
process.exit(failures === 0 ? 0 : 1);
