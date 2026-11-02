import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { installCloudWatchBridge } from "../net/cloudWatch";
import { applyTheme, loadTheme } from "./theme";

/**
 * The service asks this page for cloud status while the app is backgrounded;
 * install the entry point before the first render so it is never missing.
 */
installCloudWatchBridge();

/**
 * The remembered appearance is applied before the first paint.
 *
 * Doing it in a component effect would show one frame in the wrong palette on
 * every cold start, which on a phone reads as a flash.
 */
applyTheme(loadTheme());

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
