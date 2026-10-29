import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";

/**
 * StrictMode is on in every build, not just development: the double-invoked
 * effects it causes are exactly the ones that break a streaming view, and
 * finding that at development time is the point.
 */
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
