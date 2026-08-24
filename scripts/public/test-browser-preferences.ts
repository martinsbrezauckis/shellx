import assert from "node:assert/strict";
import {
  COLOR_MODE_STORAGE_KEY,
  DEFAULT_HOME_URL,
  HOME_URL_STORAGE_KEY,
  initialColorMode,
  initialHomeUrl,
  persistBrowserColorMode,
  persistBrowserHomeUrl,
} from "../../src/browser/browserPreferences";

const values = new Map<string, string>();
const localStorage = {
  getItem(key: string): string | null {
    return values.get(key) ?? null;
  },
  setItem(key: string, value: string): void {
    values.set(key, value);
  },
  removeItem(key: string): void {
    values.delete(key);
  },
};
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

try {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage },
  });

  assert.equal(initialColorMode(), "system");
  assert.equal(initialHomeUrl(), DEFAULT_HOME_URL);

  persistBrowserColorMode("dark");
  assert.equal(values.get(COLOR_MODE_STORAGE_KEY), "dark");
  assert.equal(initialColorMode(), "dark");
  persistBrowserColorMode("system");
  assert.equal(values.has(COLOR_MODE_STORAGE_KEY), false);

  assert.equal(persistBrowserHomeUrl(" https://shellx.invalid/home "), "https://shellx.invalid/home");
  assert.equal(values.get(HOME_URL_STORAGE_KEY), "https://shellx.invalid/home");
  assert.equal(initialHomeUrl(), "https://shellx.invalid/home");
  assert.equal(persistBrowserHomeUrl(DEFAULT_HOME_URL), DEFAULT_HOME_URL);
  assert.equal(values.has(HOME_URL_STORAGE_KEY), false);
  assert.equal(persistBrowserHomeUrl("  "), DEFAULT_HOME_URL);
  assert.equal(values.has(HOME_URL_STORAGE_KEY), false);

  console.log("Browser preference canonical persistence tests passed");
} finally {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
}
