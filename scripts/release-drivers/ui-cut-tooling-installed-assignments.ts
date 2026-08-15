export const CUT_TOOLING_CONTROL_DRIVER_ID = "ui-control-cut-tooling-installed";
export const CUT_TOOLING_FIXTURE = "ui:owned-session-without-cut-host-context";
export const CUT_TOOLING_CLEANUP = "ui:restore-right-rail-after-cut-status-check";
export const CUT_TOOLING_ORACLE = "ui:activation:cut-status-checked-open-unavailable-fail-closed";

export const CUT_TOOLING_CONTROL_SURFACE_IDS = new Set([
  'ui-control:src/components/CutToolingRow.tsx::is([aria-label="Open ShellX Cut"],[aria-label="ShellX Cut Open unavailable"])@src/components/CutToolingRow.tsx#2',
  'ui-control:src/components/CutToolingRow.tsx:[aria-label="Check ShellX Cut status"]@src/components/CutToolingRow.tsx#1',
]);
