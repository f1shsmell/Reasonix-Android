/**
 * The last line of defence for a render that throws.
 *
 * A phone has no devtools open. Without this, one unexpected shape from a
 * newer kernel blanks the WebView to white and the only recovery is to force
 * stop the app. The boundary keeps the failure on screen and offers both a
 * reload and a way back to the previous state.
 */

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The device log is the only place this will ever be read.
    console.error("render failed", error, info.componentStack);
  }

  render() {
    const error = this.state.error;
    if (error !== null) {
      return (
        <div className="centered">
          <div>
            <strong>界面出错了</strong>
            <p className="why">{error.message || "未知错误"}</p>
            <button type="button" onClick={() => window.location.reload()}>
              重新加载
            </button>
            <button type="button" onClick={() => this.setState({ error: null })}>
              返回
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
