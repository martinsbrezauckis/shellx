import { inferBrowserTaskStartUrl } from "../src/browser/taskIntent";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`✓ ${message}`);
}

const googleSearch = inferBrowserTaskStartUrl(
  "lets open google.com and search for info about best white bread in the world",
  "https://example.org/",
);

assert(
  googleSearch === "https://www.google.com/search?q=info+about+best+white+bread+in+the+world",
  "explicit Google search task starts at a Google search URL instead of the current page",
);

const googleOpen = inferBrowserTaskStartUrl("open google.com", "https://example.org/");
assert(googleOpen === "https://google.com/", "plain open-domain task starts at the requested domain");

const currentPageTask = inferBrowserTaskStartUrl("summarize this page", "https://example.org/");
assert(currentPageTask === "https://example.org/", "current-page task keeps the current page URL");

const blankTask = inferBrowserTaskStartUrl("research secure vault UX patterns", "");
assert(blankTask === null, "task without explicit navigation or current page starts without a URL");
