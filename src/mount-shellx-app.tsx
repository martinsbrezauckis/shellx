import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/onest";
import "./styles/tokens.css";
import App from "./App";
import "./App.css";
import "./components/MediaPreview.css";
import "./styles/interactionAccessibility.css";
import { ErrorBoundary } from "./components/ErrorBoundary";

export function mountShellxApp(): void {
  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("#root element missing — index.html out of sync");

  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
