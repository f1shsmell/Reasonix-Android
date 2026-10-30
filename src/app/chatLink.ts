/**
 * The link a decision notification carries.
 *
 * `reasonix://chat?runtime=<id>&root=<path>&title=<title>` is internal: it is
 * produced by the foreground service and handled by this app, never opened from
 * outside. Parsing it apart keeps that contract testable without a notification.
 */

export interface ChatLink {
  runtimeId: string;
  root?: string;
  title?: string;
}

export function parseChatLink(raw: string): ChatLink | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "reasonix:" || url.host !== "chat") return null;
    const runtimeId = (url.searchParams.get("runtime") ?? "").trim();
    if (!runtimeId) return null;
    const root = (url.searchParams.get("root") ?? "").trim();
    const title = (url.searchParams.get("title") ?? "").trim();
    return {
      runtimeId,
      ...(root ? { root } : {}),
      ...(title ? { title } : {}),
    };
  } catch {
    return null;
  }
}
