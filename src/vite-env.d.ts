/**
 * Vite's `import.meta.env` exposes `MODE` ("development" | "production")
 * plus user-defined `VITE_*` env vars. This mirrors what `vite/client`
 * ships for the app's direct environment reads.
 */
interface ImportMetaEnv {
  readonly MODE: string;
  readonly BASE_URL: string;
  readonly PROD: boolean;
  readonly DEV: boolean;
  readonly SSR: boolean;
  readonly [key: string]: string | boolean | undefined;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Vite asset-as-URL import. Resolves to a string
 * that's the final URL of the asset after bundling. Used for the
 * shellX brand image in Header.tsx.
 *
 *revision brand asset switched from SVG to PNG —
 * the vector-pack SVG did not match the source brand sheet 1:1 (gap
 * between "Shell" and "X" was too wide, glyph geometry differed). PNG
 * is a direct crop of the source brand sheet, so it's pixel-perfect to
 * the intended look. Header consumes it at height=32 — asset ships at
 * 521x128 (4x the displayed height) so it stays crisp on HiDPI panels
 * while keeping the bundle small.
 */
declare module "*.svg?url" {
  const url: string;
  export default url;
}
declare module "*.png?url" {
  const url: string;
  export default url;
}
declare module "*.md?raw" {
  const raw: string;
  export default raw;
}
declare module "*.toml?raw" {
  const raw: string;
  export default raw;
}
declare module "*.json?raw" {
  const raw: string;
  export default raw;
}
