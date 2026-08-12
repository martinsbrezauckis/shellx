export async function checkReleaseSurfaceHttpLink(
  href: string,
  options: {
    fetchImpl?: typeof fetch;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<"ok" | "broken"> {
  if (!href.startsWith("https://")) return "broken";
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const retryDelaysMs = [0, 250, 1_000] as const;
  for (const retryDelayMs of retryDelaysMs) {
    if (retryDelayMs > 0) await wait(retryDelayMs);
    try {
      let current = new URL(href);
      const visited = new Set<string>();
      for (let hop = 0; hop <= 5; hop += 1) {
        if (current.protocol !== "https:" || visited.has(current.href)) break;
        visited.add(current.href);
        const response = await fetchImpl(current.href, {
          method: "GET",
          redirect: "manual",
          headers: { "User-Agent": "ShellX-Release-Link-Check/1" },
          signal: AbortSignal.timeout(15_000),
        });
        await response.body?.cancel();
        if (response.status >= 200 && response.status < 300) return "ok";
        if (response.status < 300 || response.status >= 400 || hop === 5) break;
        const location = response.headers.get("location");
        if (!location) break;
        const next = new URL(location, current);
        if (next.protocol !== "https:") break;
        current = next;
      }
    } catch {
      // A final broken verdict requires three independent bounded attempts.
    }
  }
  return "broken";
}
