import { Capacitor } from "@capacitor/core";

/**
 * What the About row shows. The native side owns the version comparison and
 * the download; this layer only turns its answers into one row of text.
 */
export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest"; version: string }
  | {
      kind: "available";
      version: string;
      versionCode: number;
      url: string;
      mirrors: string[];
      notes: string;
    }
  | { kind: "downloading"; version: string; transferred: number; total: number }
  | { kind: "permission"; version: string }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string; retry: "check" | "install" };

export interface UpdateRowText {
  title: string;
  sub: string;
  action: string;
  error: boolean;
}

/** The row only exists inside the Android shell; a browser has no installer. */
export function isNativeUpdate(): boolean {
  return Capacitor.isNativePlatform();
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function progressText(transferred: number, total: number): string {
  if (total > 0) {
    const percent = Math.min(100, Math.max(0, Math.round((transferred / total) * 100)));
    return `${formatBytes(transferred)} / ${formatBytes(total)} · ${percent}%`;
  }
  return `${formatBytes(transferred)} · 下载中`;
}

/** The first line of a release note, which is what fits under a settings row. */
export function noteSummary(notes: string): string {
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(">")) continue;
    const text = line
      .replace(/^[-*•]\s+/, "")
      .replace(/\*\*/g, "")
      .trim();
    if (!text) continue;
    return text.length > 90 ? `${text.slice(0, 89)}…` : text;
  }
  return "点此下载并安装";
}

export function describeUpdate(status: UpdateStatus): UpdateRowText {
  switch (status.kind) {
    case "idle":
      return { title: "更新", sub: "检查是否有新版本", action: "检查", error: false };
    case "checking":
      return { title: "更新", sub: "正在检查…", action: "", error: false };
    case "latest":
      return {
        title: "更新",
        sub: `已是最新版本 ${status.version}`,
        action: "重新检查",
        error: false,
      };
    case "available":
      return {
        title: `发现新版本 ${status.version}`,
        sub: noteSummary(status.notes),
        action: "下载",
        error: false,
      };
    case "downloading":
      return {
        title: `正在下载 ${status.version}`,
        sub: progressText(status.transferred, status.total),
        action: "",
        error: false,
      };
    case "permission":
      return {
        title: `已下载 ${status.version}`,
        sub: "到系统设置允许安装未知应用，然后回来继续",
        action: "继续安装",
        error: false,
      };
    case "downloaded":
      return {
        title: "安装包已就绪",
        sub: "系统安装器已打开；没看到就再点一次",
        action: "重新打开",
        error: false,
      };
    case "error":
      return { title: "更新失败", sub: status.message, action: "重试", error: true };
  }
}

/** Native failures carry a code; the sentence is the UI's job, not the bridge's. */
export function updateFailure(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case "UPDATE_NETWORK":
      return "连不上 GitHub，检查网络后再试";
    case "UPDATE_MANIFEST":
      return "更新清单读取失败，稍后再试";
    case "UPDATE_DOWNLOAD":
      return "安装包下载失败，稍后再试";
    case "UPDATE_VERIFY":
      return "安装包校验失败，请重试";
    case "UPDATE_INSTALL":
      return "系统安装器没有打开，请重试";
    case "UPDATE_BUSY":
      return "正在下载，请稍等";
    case "UPDATE_STALE":
      return "下载已失效，请重新检查更新";
    default:
      return "更新失败，请稍后再试";
  }
}
