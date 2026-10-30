import { registerPlugin } from "@capacitor/core";

/**
 * The Studio share page in a hidden app WebView. Its `#pair=` bootstrap is
 * the pairing path a browser uses; the proxy then reuses the cookie.
 *
 * `reason` separates a person closing the sheet from a page that never
 * answered, because only the latter may fall through to the direct exchange.
 */
export type PairReason =
  | "paired"
  | "cancelled"
  | "timeout"
  | "load_failed"
  | "invalid_url"
  | "unavailable";

export interface PairResult {
  paired: boolean;
  reason?: PairReason;
}

export interface PairPlugin {
  pair(options: { url: string; origin: string }): Promise<PairResult>;
}

export const NativePair = registerPlugin<PairPlugin>("Pair");
