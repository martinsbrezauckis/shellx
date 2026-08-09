import { lazy, Suspense, type JSX } from "react";
import type { TerminalViewProps } from "./TerminalView";

const loadTerminalView = () => import("./TerminalView").then((module) => ({
  default: module.TerminalView,
}));
const TerminalView = lazy(loadTerminalView);

export function preloadTerminalView(): void {
  void loadTerminalView();
}

export function LazyTerminalView(props: TerminalViewProps): JSX.Element {
  return (
    <Suspense fallback={<div className="terminal-host" aria-label="Loading terminal" aria-busy="true" />}>
      <TerminalView {...props} />
    </Suspense>
  );
}
