/// <reference types="node" />
/**
 * vite.config.ts — Vite config tuned for Tauri v2.
 *
 * Notes:
 * - Default port 5173 matches Tauri's static devUrl. Override at runtime
 *   via `GROK_SHELL_VITE_PORT=<N>` env var to dodge collisions with
 *   other projects running their own Vite (every Vite scaffold defaults
 *   to 5173). Use `scripts/dev.sh` to launch — it reads the same env var
 *   and templates Tauri's devUrl to match.
 * - strictPort=true so a port collision fails fast instead of Vite
 *   silently switching ports and Tauri loading nothing.
 * - clearScreen=false so we can see Vite errors alongside `tauri dev`
 *   noise in the same terminal.
 * - The HMR host trick (resolving WSL2 IP) is unnecessary while we dev
 *   inside WSL with Tauri also in WSL — both see localhost the same way.
 *   When P6 cross-builds for Windows that runs against a WSL-hosted dev
 *   server, revisit.
 * - `__APP_GIT_TIP__` is injected via `define` so the Settings → About
 *   tab can show the build's commit hash. Best-effort: if `git rev-parse`
 *   fails (shallow checkout, missing git binary), the placeholder
 *   `"unknown"` ships through and the About tab degrades gracefully.
 */
import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const VITE_PORT = Number(process.env.GROK_SHELL_VITE_PORT ?? "5173") || 5173;

function readGitTip(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    __APP_GIT_TIP__: JSON.stringify(readGitTip()),
  },
  server: {
    port: VITE_PORT,
    strictPort: true,
  },
  // Tauri picks up `dist/` as `../dist` from src-tauri/.
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    // Shiki lazy-loads TextMate grammars as separate chunks; several
    // uncommon language grammars are 600-800 KB by themselves. Keep the
    // warning useful for truly accidental bundles without flagging those
    // expected on-demand syntax assets every release build.
    chunkSizeWarningLimit: 1000,
  },
});
