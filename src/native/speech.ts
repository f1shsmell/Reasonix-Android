import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * Dictation through the phone's own recognizer.
 *
 * Visible only in the Android app: the browser has no equivalent surface the
 * composer can share, and a silent no-op would be worse than no button.
 */
interface SpeechPlugin {
  listen(options: { language?: string }): Promise<{ text?: string }>;
}

const plugin = registerPlugin<SpeechPlugin>("Speech");

export function speechSupported(): boolean {
  return Capacitor.isNativePlatform();
}

/** Resolves with the transcript, or "" when the person cancelled the dialog. */
export async function listenForSpeech(): Promise<string> {
  const result = await plugin.listen({ language: navigator.language || "zh-CN" });
  return (result.text ?? "").trim();
}
