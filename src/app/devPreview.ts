/**
 * Dev-only screen overrides used by `scripts/ui-shots.mjs`.
 *
 * `?native=1` draws controls a browser build otherwise hides (the Studio
 * entry), and `?session=demo` opens a mock conversation so a capture lands on
 * a chat screen without clicking through Home first. `import.meta.env.DEV` is
 * replaced with `false` in a production build, so none of this reaches a
 * phone.
 */
export interface DevPreview {
  /** Draw controls that only a native shell would normally carry. */
  native: boolean;
  /** Open this mock runtime once the link is up. */
  session: string | null;
}

export function devPreview(): DevPreview | null {
  if (!import.meta.env.DEV) return null;
  const params = new URLSearchParams(window.location.search);
  const native = params.get("native") === "1";
  const session = params.get("session")?.trim() || null;
  return native || session !== null ? { native, session } : null;
}
