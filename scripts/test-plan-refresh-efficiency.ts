import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string): string => readFileSync(path, "utf8");
const hook = read("src/lib/useEventAwarePolling.ts");
const rightRail = read("src/components/RightRail.tsx");
const goalReview = read("src/components/GoalPlanReviewModal.tsx");
const buildReview = read("src/components/BuildPlanReviewModal.tsx");

assert.match(hook, /eventDelayMs = 180/,
  "event-triggered state refreshes retain a bounded trailing delay");
assert.match(hook, /if \(inFlightRef\.current\)[\s\S]*rerunRef\.current = true/,
  "overlapping host reads coalesce into one pending refresh");
assert.match(hook, /generation === generationRef\.current/,
  "async reads retain a current-scope guard");
assert.match(hook, /previous\.eventRevision === eventRevision/,
  "an unchanged renderer revision cannot schedule redundant host work");

assert.equal((rightRail.match(/useEventAwarePolling\(\{/g) ?? []).length, 5,
  "Plan owns bounded goal/build polling plus three bounded scratchboard readers");
assert.equal((rightRail.match(/invoke<unknown>\("get_goal_state"/g) ?? []).length, 1,
  "Plan scratchboard and Goal status bar must share one host state reader");
assert.equal((goalReview.match(/useEventAwarePolling\(\{/g) ?? []).length, 2,
  "Goal review owns one stable state poll and one bounded plan reader");
assert.equal((buildReview.match(/useEventAwarePolling\(\{/g) ?? []).length, 2,
  "Build review owns one stable state poll and one bounded plan reader");

assert.doesNotMatch(rightRail, /\[activeTabId, events\.length\]/,
  "Plan state polling must not recreate an interval for every renderer event");
assert.doesNotMatch(rightRail, /\[(?:goalScratchboardPath|buildState\?\.scratchboardPath|planFilePath), events\.length/,
  "Plan scratchboard reads must not run once per renderer event");
assert.doesNotMatch(goalReview, /\[effectiveTabId, eventsLen, fixture\]/,
  "Goal review polling must not recreate an interval for every renderer event");
assert.doesNotMatch(buildReview, /\[activeTabId, eventsLen, debugFixture\]/,
  "Build review polling must not recreate an interval for every renderer event");

console.log("Plan refresh efficiency contracts passed (9 bounded refresh owners, one shared Goal reader, no event-recreated polling loops).");
