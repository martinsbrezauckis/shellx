/**
 * src/main.tsx — React entry point for the ShellX renderer.
 *
 * Loads (in order):
 *   1. Onest Variable font (replaces paid universalSans per design plan)
 *   2. tokens.css — palette + spacing + base body styles
 *   3. App.css — ordered ownership modules for the ShellX application shell
 *   4. <App/> root component
 *
 * All app surfaces live in components/ and compose inside App.tsx.
 */
import React from "react";
import ReactDOM from "react-dom/client";

// Variable-axis Onest from @fontsource-variable/onest. Single file covers
// every weight we need (400 body, 500 labels, 550 display, 600 send pill).
import "@fontsource-variable/onest";

// Design tokens + base body (palette, spacing, font stacks, @font-face for
// Geist Mono). Loaded BEFORE App.css so every ownership module can read the
// CSS variables.
import "./styles/tokens.css";

import App from "./App";
import "./App.css";
import "./components/MediaPreview.css";
import "./styles/interactionAccessibility.css";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ReleaseSurfaceRendererHealthObserver } from "./components/ReleaseSurfaceRendererHealthObserver";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element missing — index.html out of sync");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ReleaseSurfaceRendererHealthObserver />
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
