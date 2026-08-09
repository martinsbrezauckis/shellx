pub const SHELLX_BUILD_COMMIT: &str = match option_env!("SHELLX_BUILD_COMMIT") {
    Some(value) => value,
    None => "unknown",
};

pub const BROWSER_PROTOCOL_VERSION: &str = "1.5.0";
pub const BROWSER_SCHEMA_REVISION: &str = "2026-07-17.1";

pub const BROWSER_FEATURE_FLAGS: &[&str] = &[
    "operatorAuthoritativeTakeover",
    "surfaceAuthenticatedControlActor",
    "taskOwnerPrincipal",
    "boundedBrowserSummary",
    "eventRevisionRefresh",
    "compactNavigationSettle",
    "quietBrowserCheck",
    "hiddenRenderedCheck",
    "rollbackSafeTaskStart",
    "stableElementRefs",
    "observationDeltas",
    "domStabilityWaits",
    "scopedDomTraversal",
    "recipeBackedRobotRuns",
    "browserCoworkSession",
    "browserFixedAssistedPolicy",
];
