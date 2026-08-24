/// <reference types="node" />
/**
 * vite.config.ts — Vite config tuned for Tauri v2.
 *
 * Notes:
 * - Default port 5173 matches Tauri's static devUrl. Override at runtime
 *   via `SHELLX_VITE_PORT=<N>` env var to dodge collisions with
 *   other projects running their own Vite (every Vite scaffold defaults
 *   to 5173). `GROK_SHELL_VITE_PORT` remains a legacy fallback. Use
 *   the Tauri development command to launch; both layers read the same env vars
 *   and keep Tauri's devUrl aligned with the chosen port.
 * - strictPort=true so a port collision fails fast instead of Vite
 *   silently switching ports and Tauri loading nothing.
 * - clearScreen=false so we can see Vite errors alongside `tauri dev`
 *   noise in the same terminal.
 * - No HMR host override is needed when Vite and Tauri share localhost.
 *   Revisit only for cross-host development against a separately hosted
 *   Vite server.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const VITE_PORT = Number(process.env.SHELLX_VITE_PORT ?? process.env.GROK_SHELL_VITE_PORT ?? "5173") || 5173;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: VITE_PORT,
    strictPort: true,
    watch: {
      // Cargo writes and locks DLLs under this tree while `tauri dev` is
      // running. Watching it can crash Vite with EBUSY on native Windows.
      ignored: ["**/src-tauri/target/**"],
    },
  },
  // Tauri picks up `dist/` as `../dist` from src-tauri/.
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: {
        shellx: resolve(process.cwd(), "index.html"),
        browser: resolve(process.cwd(), "shellx-browser.html"),
      },
    },
    // Shiki lazy-loads TextMate grammars as separate chunks; several
    // uncommon language grammars are 600-800 KB by themselves. Keep the
    // warning useful for truly accidental bundles without flagging those
    // expected on-demand syntax assets every release build.
    chunkSizeWarningLimit: 1000,
  },
});
