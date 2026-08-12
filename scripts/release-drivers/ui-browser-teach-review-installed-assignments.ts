export const BROWSER_TEACH_CONTROL_DRIVER_ID = "ui-control-browser-teach-review-installed";
export const BROWSER_TEACH_DEBUG_DRIVER_ID = "ui-debug-browser-teach-review-installed";

export const BROWSER_TEACH_INSTALLED_FIXTURE = "ui:browser-teach-owned-flight-recorder-review";
export const BROWSER_TEACH_INSTALLED_CLEANUP = "ui:delete-owned-teach-evidence-key-lock-disposable-vault-and-candidate-teardown";
export const BROWSER_TEACH_INSTALLED_CONTROL_ORACLES = [
  "ui:activation:browser-teach-native-review-lifecycle",
  "ui:boolean-state-transition",
  "ui:value-state-transition",
  "ui:choice-state-transition",
] as const;
export const BROWSER_TEACH_INSTALLED_DEBUG_ORACLE = "ui:visible:browser-teach-owned-native-lifecycle-marker";

export const BROWSER_TEACH_CONTROL_SURFACE_IDS = new Set([
  'ui-control:src/browser/components/BrowserTeachReview.tsx:[data-debug-id^="shellx-browser-teach-issue-action-"]@src/browser/components/BrowserTeachReview.tsx#4',
  'ui-control:src/browser/components/BrowserTeachReview.tsx:[data-debug-id^="shellx-browser-teach-value-label-"]@src/browser/components/BrowserTeachReview.tsx#5',
  'ui-control:src/browser/components/BrowserTeachReview.tsx:[data-debug-id^="shellx-browser-teach-value-literal-"]@src/browser/components/BrowserTeachReview.tsx#7',
  'ui-control:src/browser/components/BrowserTeachReview.tsx:[data-debug-id^="shellx-browser-teach-vault-binding-"]@src/browser/components/BrowserTeachReview.tsx#6',
  'ui-control:src/browser/components/BrowserTeachReview.tsx:[data-debug-id="shellx-browser-teach-approve-recipe"]@src/browser/components/BrowserTeachReview.tsx#10',
  'ui-control:src/browser/components/BrowserTeachReview.tsx:[data-debug-id="shellx-browser-teach-copy-approval-receipt"]@src/browser/components/BrowserTeachReview.tsx#11',
  'ui-control:src/browser/components/BrowserTeachReview.tsx:[data-debug-id="shellx-browser-teach-copy-rehearsal-receipt"]@src/browser/components/BrowserTeachReview.tsx#12',
  'ui-control:src/browser/components/BrowserTeachReview.tsx:[data-debug-id="shellx-browser-teach-goal"]@src/browser/components/BrowserTeachReview.tsx#3',
  'ui-control:src/browser/components/BrowserTeachReview.tsx:[data-debug-id="shellx-browser-teach-rehearse"]@src/browser/components/BrowserTeachReview.tsx#9',
  'ui-control:src/browser/components/BrowserTeachReview.tsx:[data-debug-id="shellx-browser-teach-reload-stale"]@src/browser/components/BrowserTeachReview.tsx#2',
  'ui-control:src/browser/components/BrowserTeachReview.tsx:[data-debug-id="shellx-browser-teach-retry"]@src/browser/components/BrowserTeachReview.tsx#1',
  'ui-control:src/browser/components/BrowserTeachReview.tsx:[data-debug-id="shellx-browser-teach-save-draft"]@src/browser/components/BrowserTeachReview.tsx#8',
]);

export const BROWSER_TEACH_DEBUG_ASSIGNMENT_IDS = new Set([
  "ui-debug-surface:shellx-browser-teach-action-summary@src/browser/components/BrowserTeachReview.tsx#8",
  "ui-debug-surface:shellx-browser-teach-approval-receipt@src/browser/components/BrowserTeachReview.tsx#24",
  "ui-debug-surface:shellx-browser-teach-approve-recipe@src/browser/components/BrowserTeachReview.tsx#23",
  "ui-debug-surface:shellx-browser-teach-blocking@src/browser/components/BrowserTeachReview.tsx#9",
  "ui-debug-surface:shellx-browser-teach-copy-approval-receipt@src/browser/components/BrowserTeachReview.tsx#25",
  "ui-debug-surface:shellx-browser-teach-copy-rehearsal-receipt@src/browser/components/BrowserTeachReview.tsx#27",
  "ui-debug-surface:shellx-browser-teach-goal@src/browser/components/BrowserTeachReview.tsx#7",
  "ui-debug-surface:shellx-browser-teach-issue-*@src/browser/components/BrowserTeachReview.tsx#11",
  "ui-debug-surface:shellx-browser-teach-issue-action-*@src/browser/components/BrowserTeachReview.tsx#12",
  "ui-debug-surface:shellx-browser-teach-issues@src/browser/components/BrowserTeachReview.tsx#10",
  "ui-debug-surface:shellx-browser-teach-redaction@src/browser/components/BrowserTeachReview.tsx#6",
  "ui-debug-surface:shellx-browser-teach-rehearsal-receipt@src/browser/components/BrowserTeachReview.tsx#26",
  "ui-debug-surface:shellx-browser-teach-rehearse@src/browser/components/BrowserTeachReview.tsx#22",
  "ui-debug-surface:shellx-browser-teach-reload-stale@src/browser/components/BrowserTeachReview.tsx#4",
  "ui-debug-surface:shellx-browser-teach-retry@src/browser/components/BrowserTeachReview.tsx#3",
  "ui-debug-surface:shellx-browser-teach-review@src/browser/components/BrowserTeachReview.tsx#1",
  "ui-debug-surface:shellx-browser-teach-save-draft@src/browser/components/BrowserTeachReview.tsx#21",
  "ui-debug-surface:shellx-browser-teach-source@src/browser/components/BrowserTeachReview.tsx#5",
  "ui-debug-surface:shellx-browser-teach-state-*@src/browser/components/BrowserTeachReview.tsx#2",
  "ui-debug-surface:shellx-browser-teach-step-*@src/browser/components/BrowserTeachReview.tsx#14",
  "ui-debug-surface:shellx-browser-teach-steps@src/browser/components/BrowserTeachReview.tsx#13",
  "ui-debug-surface:shellx-browser-teach-value-*@src/browser/components/BrowserTeachReview.tsx#16",
  "ui-debug-surface:shellx-browser-teach-value-label-*@src/browser/components/BrowserTeachReview.tsx#17",
  "ui-debug-surface:shellx-browser-teach-value-literal-*@src/browser/components/BrowserTeachReview.tsx#19",
  "ui-debug-surface:shellx-browser-teach-values@src/browser/components/BrowserTeachReview.tsx#15",
  "ui-debug-surface:shellx-browser-teach-vault-binding-*@src/browser/components/BrowserTeachReview.tsx#18",
  "ui-debug-surface:shellx-browser-teach-vault-unavailable@src/browser/components/BrowserTeachReview.tsx#20",
]);

export const BROWSER_TEACH_DEBUG_SURFACE_IDS = new Set([
  "shellx-browser-teach-action-summary", "shellx-browser-teach-approval-receipt",
  "shellx-browser-teach-approve-recipe", "shellx-browser-teach-blocking",
  "shellx-browser-teach-copy-approval-receipt", "shellx-browser-teach-copy-rehearsal-receipt",
  "shellx-browser-teach-goal", "shellx-browser-teach-issue-*",
  "shellx-browser-teach-issue-action-*", "shellx-browser-teach-issues",
  "shellx-browser-teach-redaction", "shellx-browser-teach-rehearsal-receipt",
  "shellx-browser-teach-rehearse", "shellx-browser-teach-reload-stale",
  "shellx-browser-teach-retry", "shellx-browser-teach-review",
  "shellx-browser-teach-save-draft", "shellx-browser-teach-source",
  "shellx-browser-teach-state-*", "shellx-browser-teach-step-*",
  "shellx-browser-teach-steps", "shellx-browser-teach-value-*",
  "shellx-browser-teach-value-label-*", "shellx-browser-teach-value-literal-*",
  "shellx-browser-teach-values", "shellx-browser-teach-vault-binding-*",
  "shellx-browser-teach-vault-unavailable",
]);
