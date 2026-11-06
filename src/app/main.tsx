import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { installCloudWatchBridge } from "../net/cloudWatch";
import { applyTheme, loadTheme } from "./theme";
import { applyChatFont, loadChatFont } from "../chat/chatFont";
import { applyUiStyle, loadUiStyle } from "./uiStyle";
import { migrateSettings } from "./settings";

/**
 * The service asks this page for cloud status while the app is backgrounded;
 * install the entry point before the first render so it is never missing.
 */
installCloudWatchBridge();

/**
 * Start the page.
 *
 * A mock-kernel dev session swaps the transport before any endpoint runs; the
 * import stays dynamic so a production build can drop the fixture completely.
 */
async function start(): Promise<void> {
  if (import.meta.env.DEV && import.meta.env.VITE_REASONIX_MOCK === "1") {
    const { installMockKernel } = await import("../net/mock/kernel");
    installMockKernel();
  }

  migrateSettings();

  /**
   * The remembered appearance is applied before the first paint.
   *
   * Doing it in a component effect would show one frame in the wrong palette on
   * every cold start, which on a phone reads as a flash. The chat font scale
   * rides along: a wrong size is the same first-frame lie.
   */
  applyUiStyle(loadUiStyle());
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
}

void start();