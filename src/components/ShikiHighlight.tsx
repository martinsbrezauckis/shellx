/**
 * src/components/ShikiHighlight.tsx — syntax-highlighted code block
 * powered by Shiki .
 *
 * Why Shiki: it ships TextMate-grade tokenizers, runs in the browser
 * (WASM oniguruma + JSON grammars), and stays small if we whitelist
 * languages. We pick `min-dark` for the theme — high-contrast, sober,
 * matches our locked palette better than `vesper`/`vitesse-dark` did
 * in side-by-side tests.
 *
 * Loading model: lazy-imports `shiki/bundle/web` on first render and
 * memoizes the highlighter for the rest of the session. Languages
 * load on demand — we don't preload everything; ~10ms hit per new
 * extension.
 *
 * Fallback: if Shiki throws (offline, language unknown), we render
 * a numbered <pre> with the original text. The legacy CodePreview
 * shape is preserved (line-numbered) so a Shiki failure doesn't
 * lose information.
 *
 * Constraint: this is a NEW component — RightRail.tsx swaps its
 * `<CodePreview>` impl to this one.
 */
import { useEffect, useState, type JSX } from "react";
import { shikiLangForPath } from "../lib/file-preview-types";

/* Loaded once, shared across all instances. */
let highlighterPromise: Promise<any> | null = null;

const THEME = "min-dark";

function loadShiki(): Promise<any> {
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = (async () => {
    const shiki = await import("shiki");
    const hi = await shiki.createHighlighter({
      themes: [THEME],
 // Start with empty langs; we'll loadLanguage on demand per file.
      langs: [],
    });
    return hi;
  })();
  return highlighterPromise;
}

export function ShikiHighlight({
  code,
  path,
}: {
  code: string;
 /** Used to derive the language from file extension. */
  path: string;
}): JSX.Element {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const lang = shikiLangForPath(path);
    (async () => {
      try {
        const hi = await loadShiki();
        if (cancelled) return;
        if (lang) {
          const loaded = hi.getLoadedLanguages?.() ?? [];
          if (!loaded.includes(lang)) {
            try {
              await hi.loadLanguage(lang);
            } catch {
 // Continue with plain
            }
          }
        }
        const rendered = hi.codeToHtml(code, {
          lang: lang ?? "text",
          theme: THEME,
        });
        if (!cancelled) setHtml(rendered);
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message ?? e));
      }
    })();
    return () => { cancelled = true; };
  }, [code, path]);

  if (error || (!html && code)) {
 // Fall back to the original numbered renderer if Shiki misbehaved.
    if (error) {
      console.warn("ShikiHighlight fallback:", error);
    }
    const lines = code.split("\n");
    return (
      <div className="preview">
        {lines.map((line, i) => (
          <div className="ln" key={i}>
            <span className="num">{i + 1}</span>
            <span className="src">{line || " "}</span>
          </div>
        ))}
      </div>
    );
  }

  if (!html) return <div className="preview-empty">Tokenizing…</div>;

 // Shiki returns a <pre class="shiki ..."><code>...</code></pre> tree.
 // We render via dangerouslySetInnerHTML — the input is local file
 // contents under Tauri's assetProtocol scope, not network HTML.
  return (
    <div
      className="preview shiki-preview"
 // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
