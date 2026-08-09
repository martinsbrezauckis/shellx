/**
 * A local recovery boundary for code-split ShellX surfaces.
 *
 * The application-level ErrorBoundary remains the last resort. Modals and
 * browser sidecars use this component so a failed dynamic import or render
 * cannot replace the entire workspace with the global recovery screen.
 */
import { Component, Suspense, type CSSProperties, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

type LazySurfaceVariant = "overlay" | "inline";

interface LazySurfaceProps {
  children: ReactNode;
  label: string;
  onDismiss?: () => void;
  onRetry?: () => void;
  variant?: LazySurfaceVariant;
}

interface LazySurfaceState {
  error: Error | null;
}

function shellStyle(variant: LazySurfaceVariant): CSSProperties {
  return variant === "overlay"
    ? {
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "rgba(8, 8, 8, 0.72)",
      }
    : {
        minWidth: 240,
        minHeight: 120,
        display: "grid",
        placeItems: "center",
        padding: 16,
        border: "1px solid var(--control-border, var(--border))",
        background: "var(--surface)",
      };
}

function cardStyle(): CSSProperties {
  return {
    width: "min(440px, 100%)",
    padding: "16px 18px",
    border: "1px solid var(--control-border, var(--border))",
    borderRadius: 8,
    background: "var(--surface)",
    color: "var(--ink)",
    fontFamily: "var(--sans, system-ui, sans-serif)",
    boxShadow: "0 18px 60px rgba(0, 0, 0, 0.38)",
  };
}

class LazySurfaceErrorBoundary extends Component<LazySurfaceProps, LazySurfaceState> {
  state: LazySurfaceState = { error: null };

  static getDerivedStateFromError(error: Error): LazySurfaceState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[LazySurface] ${this.props.label} failed:`, error, info);
    void invoke("renderer_error", {
      message: `${this.props.label}: ${error.message || String(error)}`,
      stack: error.stack ?? null,
      componentStack: info.componentStack || null,
    }).catch(() => {
      /* Plain-browser previews have no Tauri command surface. */
    });
  }

  private retry = (): void => {
    this.props.onRetry?.();
    this.setState({ error: null });
  };

  render(): ReactNode {
    const variant = this.props.variant ?? "overlay";
    if (!this.state.error) return this.props.children;

    return (
      <div role="alert" style={shellStyle(variant)}>
        <div style={cardStyle()}>
          <strong>{this.props.label} could not open</strong>
          <p style={{ margin: "8px 0 14px", color: "var(--ink-2)", fontSize: "var(--fs-ui-sm)" }}>
            The rest of ShellX is still running. Retry this surface or close it and continue working.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="settings-pill" onClick={this.retry}>Retry</button>
            {this.props.onDismiss ? (
              <button type="button" className="settings-pill" onClick={this.props.onDismiss}>Close</button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }
}

function LazySurfaceLoading({ label, variant }: { label: string; variant: LazySurfaceVariant }): ReactNode {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" style={shellStyle(variant)}>
      <div style={cardStyle()}>Loading {label}…</div>
    </div>
  );
}

export function LazySurface({
  children,
  label,
  onDismiss,
  onRetry,
  variant = "overlay",
}: LazySurfaceProps): ReactNode {
  return (
    <LazySurfaceErrorBoundary label={label} onDismiss={onDismiss} onRetry={onRetry} variant={variant}>
      <Suspense fallback={<LazySurfaceLoading label={label} variant={variant} />}>
        {children}
      </Suspense>
    </LazySurfaceErrorBoundary>
  );
}
