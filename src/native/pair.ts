import { registerPlugin } from "@capacitor/core";

/**
 * The Studio share page in a hidden app WebView. Its `#pair=` bootstrap is
 * the pairing path a browser uses; the proxy then reuses the cookie.
 */
export interface PairPlugin {
  pair(options: { url: string; origin: string }): Promise<{ paired: boolean }>;
}

export const NativePair = registerPlugin<PairPlugin>("Pair");
