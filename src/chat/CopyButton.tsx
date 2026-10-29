/**
 * Copy text out of the WebView.
 *
 * The native Clipboard plugin is used on the phone because a WebView's
 * `navigator.clipboard` permission is not guaranteed; the browser path keeps
 * the dev session and the tests working.
 */

import { Capacitor } from "@capacitor/core";
import { Clipboard } from "@capacitor/clipboard";
import { useState } from "react";

async function write(text: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await Clipboard.write({ string: text });
    return;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("clipboard unavailable");
}

export function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");

  return (
    <button
      type="button"
      className="copy"
      aria-label={label}
      onClick={() => {
        void write(text).then(
          () => {
            setState("done");
            window.setTimeout(() => setState("idle"), 1_500);
          },
          () => {
            setState("failed");
            window.setTimeout(() => setState("idle"), 1_500);
          },
        );
      }}
    >
      {state === "done" ? "已复制" : state === "failed" ? "复制失败" : label}
    </button>
  );
}
