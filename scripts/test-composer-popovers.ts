import { readFileSync } from "node:fs";

const css = readFileSync("src/App.css", "utf8");
const bottomPanel = readFileSync("src/components/BottomPanel.tsx", "utf8");

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "m").exec(css);
  return match?.[1] ?? "";
}

console.log("\n=== composer popover placement ===");

const slashRule = cssRule(".slash-pop");
assert(slashRule.includes("position: fixed"), "slash autocomplete is viewport-positioned, not clipped by panels");
assert(/z-index:\s*9\d{3}/.test(slashRule), "slash autocomplete renders above chat and bottom panels");
assert(bottomPanel.includes("createPortal(") && bottomPanel.includes('className="slash-pop"'), "slash autocomplete renders through a portal");
assert(!bottomPanel.includes('className="slash-pop"') || !bottomPanel.includes('position: "absolute"'), "slash autocomplete does not use clipped absolute positioning");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} composer popover tests`);
process.exit(failures === 0 ? 0 : 1);
