import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { readNormalizedTextFileSync as readFileSync } from "./lib/text-content";

function sourceDisablesSmartScreen(source: string): boolean {
  return source.replace(/[^a-z0-9]/gi, "").toLowerCase().includes("mssmartscreenprotection");
}

const expectedWebView2Args = "--disable-features=msWebOOUI,msPdfOOUI --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding";
const tauriConfigSource = readFileSync("src-tauri/tauri.conf.json");
const nativeShippingSources = readdirSync("src-tauri/src", { recursive: true })
  .filter((path): path is string => typeof path === "string" && path.endsWith(".rs"))
  .map((path) => readFileSync(`src-tauri/src/${path}`));
const shippingWebView2Sources = [tauriConfigSource, ...nativeShippingSources].join("\n");
const childWebViewArgsSource = readFileSync("src-tauri/src/shellx_browser_webview_runtime.rs");

assert.equal(
  sourceDisablesSmartScreen(shippingWebView2Sources),
  false,
  "shipping Windows WebView2 sources must not disable SmartScreen",
);
assert(
  [
    "--disable-features=msSmartScreenProtection",
    "--disable-features=msPdfOOUI,MsSmartScreenProtection",
    "--disable-features=msPdfOOUI,MS_SMART_SCREEN_PROTECTION",
  ].every(sourceDisablesSmartScreen),
  "SmartScreen guard must detect direct, combined, and case-varied disable arguments",
);
assert(
  tauriConfigSource.includes(`"additionalBrowserArgs": "${expectedWebView2Args}"`)
    && childWebViewArgsSource.includes("--disable-features=msWebOOUI,msPdfOOUI")
    && ["--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"].every((flag) => childWebViewArgsSource.includes(flag)),
  "main and child WebViews retain the required non-SmartScreen arguments",
);

console.log("Windows WebView hardening contracts passed");
