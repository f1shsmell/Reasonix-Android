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
