/**
 * src/components/ErrorBoundary.tsx — last-resort renderer error catcher.
 *
 * a.
 *
 * Wraps <App/> at the top of the React tree. Without this, ANY throw
 * during render in any descendant component unmounts the whole tree and
 * the WebView paints a blank window — exactly the "black screen with
 * only the close X" symptom the user hit when (a) opening the Terminal
 * tab before any ACP connect, and (b) closing the last chat tab.
 *
 * Behaviour:
 * - On a render-throw or lifecycle-throw, we keep the tree mounted but
 * swap the children for an inline error card showing the message +
 * a "Reload window" button (Tauri webview reload is non-destructive
 * for Rust-side state, including the active grok ACP child).
 * - The error is also logged to console + to a Tauri event
 * `renderer-error` so a future debug-api loop can surface it.
 *
 * Note: error boundaries do NOT catch async throws inside event
 * handlers or in useEffect bodies that escape the React stack. For
 * those we rely on per-component try/catch (e.g. MicButton.start,
 * TerminalView mount async IIFE). This boundary catches the COMMON
 * case — a render-time null deref turning into a black screen.
 */
import React, { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
 /** The app tree we're protecting. */
  children: ReactNode;
}

interface State {
 /** Captured error, or null when the tree is healthy. */
  error: Error | null;
 /** Component stack from React's errorInfo — useful for triage. */
  componentStack: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
 // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] caught render-time throw:", error, info);
    this.setState({ componentStack: info.componentStack || "" });

 // removed forward-declared invoke of
 // `renderer_error` — the Tauri command was never implemented and the
 // .catch swallow made the dead call invisible. A future
 // `/state/renderer-error` endpoint can re-add a real wire here.
  }

 /** Reset state so a Reload click can re-render the subtree without
 * requiring a full window.location.reload (which would re-fetch the
 * HTML and lose any in-memory state Tauri-side). */
  private handleReset = (): void => {
    this.setState({ error: null, componentStack: "" });
  };

 /** Full window reload — last resort when reset alone doesn't recover
 * (e.g. a corrupted localStorage entry that throws on every render).
 * In Tauri the renderer reloads but the Rust process stays up so
 * active grok ACP sessions survive. */
  private handleReload = (): void => {
    try {
      window.location.reload();
    } catch {
 /* no-op */
    }
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    const msg = this.state.error.message || String(this.state.error);
    const stack = this.state.error.stack ?? "";

    return (
      <div
        role="alert"
        style={{
          position: "fixed",
          inset: 0,
          padding: "32px",
          fontFamily: "var(--mono, ui-monospace, Menlo, monospace)",
          fontSize: "var(--fs-ui-sm)",
          color: "#e8e8e8",
          background: "#0a0a0a",
          overflow: "auto",
          zIndex: 99999,
        }}
      >
        <h2 style={{ color: "#ff6b6b", margin: "0 0 12px", fontSize: 16 }}>
          shellX renderer hit an unhandled error
        </h2>
        <p style={{ color: "#bbb", marginBottom: 12 }}>
          The React tree threw during render. The Rust backend is still
          running — grok ACP sessions, terminal PTYs, and the debug-api
          are unaffected. You can try resetting the UI; if it keeps
          throwing, reload the window.
        </p>
        <div style={{
          background: "#1a1a1a",
          border: "1px solid #333",
          borderRadius: 4,
          padding: "10px 12px",
          marginBottom: 10,
          wordBreak: "break-word",
        }}>
          <strong style={{ color: "#ff9b6b" }}>{msg}</strong>
        </div>
        {stack && (
          <details style={{ marginBottom: 12 }}>
            <summary style={{ cursor: "pointer", color: "#888" }}>
              stack trace
            </summary>
            <pre style={{
              background: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: 4,
              padding: "10px 12px",
              marginTop: 6,
              fontSize: "var(--fs-ui-xs)",
              overflow: "auto",
              maxHeight: "40vh",
            }}>{stack}</pre>
          </details>
        )}
        {this.state.componentStack && (
          <details style={{ marginBottom: 12 }}>
            <summary style={{ cursor: "pointer", color: "#888" }}>
              component stack
            </summary>
            <pre style={{
              background: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: 4,
              padding: "10px 12px",
              marginTop: 6,
              fontSize: "var(--fs-ui-xs)",
              overflow: "auto",
              maxHeight: "30vh",
            }}>{this.state.componentStack}</pre>
          </details>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={this.handleReset}
            style={{
              background: "#2a2a2a",
              border: "1px solid #444",
              color: "#e8e8e8",
              padding: "8px 16px",
              borderRadius: 4,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 12,
            }}
          >
            Reset UI
          </button>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              background: "#3a2a2a",
              border: "1px solid #664444",
              color: "#ffaa88",
              padding: "8px 16px",
              borderRadius: 4,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 12,
            }}
          >
            Reload window
          </button>
        </div>
      </div>
    );
  }
}
