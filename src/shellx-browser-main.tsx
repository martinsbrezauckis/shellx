import ReactDOM from "react-dom/client";

import "@fontsource-variable/onest";
import "./styles/tokens.css";
import "./App.css";
import "./browser/browserShell.css";

import { ErrorBoundary } from "./components/ErrorBoundary";
import { ShellxBrowserApp } from "./components/ShellxBrowserApp";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("ShellX Browser root is missing");

ReactDOM.createRoot(rootEl).render(
  <ErrorBoundary>
    <ShellxBrowserApp />
  </ErrorBoundary>,
);
