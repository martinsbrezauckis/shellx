import { readFileSync } from "node:fs";
import { readAppStyles } from "./lib/app-styles";

const css = readAppStyles();
const bottomPanel = readFileSync("src/components/BottomPanel.tsx", "utf8");
const app = readFileSync("src/App.tsx", "utf8");

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

function cssRule(selector: string): string {
  const selectorIndex = css.indexOf(selector);
  if (selectorIndex === -1) return "";
  const bodyStart = css.indexOf("{", selectorIndex);
  if (bodyStart === -1) return "";
  const bodyEnd = css.indexOf("}", bodyStart + 1);
  if (bodyEnd === -1) return "";
  return css.slice(bodyStart + 1, bodyEnd);
}

console.log("\n=== composer popover placement ===");

const slashRule = cssRule(".slash-pop");
const agentPickerRule = cssRule(".agent-picker-popover");
const connectionPickerRule = cssRule(".connection-picker-pop");
assert(slashRule.includes("position: fixed"), "slash autocomplete is viewport-positioned, not clipped by panels");
assert(/z-index:\s*9\d{3}/.test(slashRule), "slash autocomplete renders above chat and bottom panels");
assert(bottomPanel.includes("createPortal(") && bottomPanel.includes('className="slash-pop"'), "slash autocomplete renders through a portal");
assert(!bottomPanel.includes('className="slash-pop"') || !bottomPanel.includes('position: "absolute"'), "slash autocomplete does not use clipped absolute positioning");
assert(bottomPanel.includes('data-placement={slashCoords.placement}'), "slash autocomplete records above/below placement");
assert(css.includes('.slash-pop[data-placement="above"]'), "slash autocomplete can open above the composer");
assert(css.includes('.slash-pop[data-placement="below"]'), "slash autocomplete can open below if there is no space above");
assert(bottomPanel.includes("normalizedSlashCommandName"), "slash autocomplete normalizes leading slashes before filtering/inserting");
assert(app.includes('name: "commands"'), "slash autocomplete includes shellX /commands fallback");
assert(app.includes('stripped === "/commands"'), "/commands is handled locally instead of being sent as an unknown prompt");
assert(agentPickerRule.includes("z-index: 9600"), "agent picker renders above chat and bottom panels");
assert(connectionPickerRule.includes("z-index: 9600"), "connection picker renders above chat and bottom panels");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} composer popover tests`);
process.exit(failures === 0 ? 0 : 1);
