import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { installCloudWatchBridge } from "../net/cloudWatch";
import { applyTheme, loadTheme } from "./theme";
import { applyChatFont, loadChatFont } from "../chat/chatFont";

/**
 * The service asks this page for cloud status while the app is backgrounded;
 * install the entry point before the first render so it is never missing.
 */
installCloudWatchBridge();

/**
 * The remembered appearance is applied before the first paint.
 *
 * Doing it in a component effect would show one frame in the wrong palette on
 * every cold start, which on a phone reads as a flash. The chat font scale
 * rides along: a wrong size is the same first-frame lie.
 */
applyTheme(loadTheme());
applyChatFont(loadChatFont());

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
