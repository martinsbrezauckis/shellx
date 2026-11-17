import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.SHELLX_PUBLIC_MANUAL_BUILD": "true",
  },
  base: "./",
  clearScreen: false,
  build: {
    target: "es2022",
    outDir: "docs/public/manual/shellx/app",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        shellx: resolve(process.cwd(), "manual-shellx.html"),
        browser: resolve(process.cwd(), "manual-browser.html"),
        browserPreview: resolve(process.cwd(), "manual-browser-preview.html"),
      },
    },
    chunkSizeWarningLimit: 1000,
  },
});
