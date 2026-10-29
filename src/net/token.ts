/**
 * The launch token reaches the app two ways, both via URL fragment so the
 * credential never lands in a request line, a log or a referrer.
 *
 * `#token=` is `reasonix serve`'s own; `#pair=` is a one-time pairing code a
 * desktop hands to a phone. Either way the fragment is wiped before anything
 * else runs, because the page can navigate and the fragment survives.
 */

import { fetchWithTimeout, RequestTimeout } from "./http";

const TOKEN_PATH = "/auth/token";
const PAIR_PATH = "/pair";
const STORAGE_KEY = "reasonix.token";

export interface BootstrapResult {
  /** A token was found in the fragment and exchanged. */
  exchanged: boolean;
  /** The fragment carried `pair` rather than `token`. */
  paired: boolean;
  /** Why an exchange failed, if it did. */
  error?: string;
}

/** Read and wipe the fragment. Returns the credential it carried, if any. */
function takeFragment(): { token?: string | undefined; pair?: string | undefined } {
  const raw = window.location.hash.slice(1);
  if (!raw) return {};
  const params = new URLSearchParams(raw);
  const token = params.get("token") ?? undefined;
  const pair = params.get("pair") ?? undefined;
  if (!token && !pair) return {};
  params.delete("token");
  params.delete("pair");
  const rest = params.toString();
  window.history.replaceState(
    null,
    "",
    window.location.pathname + window.location.search + (rest ? "#" + rest : ""),
  );
  return { token, pair };
}

/**
 * Exchange a fragment credential for a session cookie.
 *
 * The request is same-origin and sends credentials, so the `Set-Cookie` the
 * kernel answers with is what later calls ride on.
 */
export async function bootstrap(): Promise<BootstrapResult> {
  const { token, pair } = takeFragment();
  if (!token && !pair) {
    return { exchanged: false, paired: false };
  }
  const path = pair ? PAIR_PATH : TOKEN_PATH;
  const body = pair ? { code: pair } : { token };
  try {
    const response = await fetchWithTimeout(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    }, 10_000);
    if (!response.ok) {
      return { exchanged: false, paired: Boolean(pair), error: `HTTP ${response.status}` };
    }
    return { exchanged: true, paired: Boolean(pair) };
  } catch (error) {
    return {
      exchanged: false,
      paired: Boolean(pair),
      error: error instanceof RequestTimeout ? "client.timeout" : error instanceof Error ? error.message : "network error",
    };
  }
}

/** A token typed or pasted by hand, kept for the next cold start. */
export function readStoredToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // A blocked storage API costs a re-entry, not the session.
  }
}

export function forgetToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do: it is already unreachable.
  }
}
