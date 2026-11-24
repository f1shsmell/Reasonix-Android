import { compactCount } from "../app/format";

/**
 * The session's prefix-cache hit rate, as Studio states it.
 *
 * `unknown` prompt is prompt the endpoint did not split into cached and
 * uncached: the kernel bills it as uncached and leaves it out of the
 * denominator, because counting it as a miss would report a rate nobody
 * measured. Null when nothing was split at all.
 */
export function cacheRate(hit: number, miss: number, unknown = 0): number | null {
  const known = hit + miss - unknown;
  if (!(known > 0)) return null;
  return Math.min(1, hit / known);
}

/** The whole percent the meter shows; null when the rate is not known. */
export function cachePercent(hit: number, miss: number, unknown = 0): number | null {
  const rate = cacheRate(hit, miss, unknown);
  return rate === null ? null : Math.floor(rate * 100);
}

/**
 * The cache split as one line: the rate first, then the counts it came from.
 *
 * Unsplit prompt is left out of the rate by `cachePercent`, so the counts are
 * the ledger's own and need no adjustment. This lives with the numbers it
 * explains: a reading is not an action, and it reads wrong in a menu of taps.
 */
export function cacheNote(
  cache: { hit: number; miss: number; unknown: number; requests?: number } | null,
): string {
  if (!cache) return "还没有可统计的请求";
  const percent = cachePercent(cache.hit, cache.miss, cache.unknown);
  if (percent === null) return "还没有可统计的请求";
  const ledger = `${percent}% · 命中 ${compactCount(cache.hit)} · 未命中 ${compactCount(cache.miss)}`;
  // The request count is the one number the provider bills by, so it rides
  // with the cache split rather than needing its own screen.
  return cache.requests !== undefined && cache.requests > 0
    ? `${ledger} · 请求 ${compactCount(cache.requests)}`
    : ledger;
}
