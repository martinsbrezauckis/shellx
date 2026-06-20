import type { JSX, Ref } from "react";

interface EngineViewportProps {
  engineSlotRef: Ref<HTMLDivElement>;
  title: string;
  loadStatus: string;
  lastError?: string | null;
}

export function EngineViewport({ engineSlotRef, title, loadStatus, lastError }: EngineViewportProps): JSX.Element {
  return (
    <section className="shellx-browser-page">
      <div
        ref={engineSlotRef}
        className="shellx-browser-viewport shellx-browser-engine-slot"
        data-debug-id="shellx-browser-viewport"
      >
        <div className="shellx-browser-viewport-inner">
          <span className="shellx-browser-kicker">Engine status</span>
          <h2>{title}</h2>
          <p>
            Native browser engine: {loadStatus}.
            {lastError ? ` ${lastError}` : ""}
          </p>
          <div className="shellx-browser-ref-strip">
            <span>Refs</span>
            <code>@page</code>
            <code>@address</code>
            <code>@report</code>
          </div>
        </div>
      </div>
    </section>
  );
}
