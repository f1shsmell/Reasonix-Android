import { describe, expect, it } from "vitest";
import {
  describeUpdate,
  formatBytes,
  noteSummary,
  progressText,
  updateFailure,
} from "./update";

describe("update text", () => {
  it("prints a download size in the unit a phone can read", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(24_488_828)).toBe("23.4 MB");
  });

  it("prints progress without inventing a total", () => {
    expect(progressText(12 * 1024 * 1024, 24 * 1024 * 1024)).toBe("12.0 MB / 24.0 MB · 50%");
    expect(progressText(3 * 1024 * 1024, 0)).toBe("3.0 MB · 下载中");
  });

  it("takes the first real line of a release note", () => {
    expect(noteSummary("# 0.2.2\n\n- 修复连接\n- 新增更新")).toBe("修复连接");
    expect(noteSummary("> 从 0.2.0 可覆盖安装\n\n## 新增\n\n- **修复连接**")).toBe("修复连接");
    expect(noteSummary("")).toBe("点此下载并安装");
  });
});

describe("the update row", () => {
  it("offers the download when a newer release exists", () => {
    const view = describeUpdate({
      kind: "available",
      version: "0.2.2",
      versionCode: 12,
      url: "https://example.test/app.apk",
      mirrors: [],
      notes: "修复连接",
    });

    expect(view.title).toBe("发现新版本 0.2.2");
    expect(view.sub).toBe("修复连接");
    expect(view.action).toBe("下载");
    expect(view.error).toBe(false);
  });

  it("shows the percentage while downloading and no action", () => {
    const view = describeUpdate({
      kind: "downloading",
      version: "0.2.2",
      transferred: 1024 * 1024,
      total: 4 * 1024 * 1024,
    });

    expect(view.title).toBe("正在下载 0.2.2");
    expect(view.sub).toBe("1.0 MB / 4.0 MB · 25%");
    expect(view.action).toBe("");
  });

  it("asks for the installer permission, then offers the installer again", () => {
    expect(describeUpdate({ kind: "permission", version: "0.2.2" }).action).toBe("继续安装");
    expect(describeUpdate({ kind: "downloaded", version: "0.2.2" }).action).toBe("重新打开");
  });

  it("keeps the failure sentence and marks the row", () => {
    const view = describeUpdate({
      kind: "error",
      message: "连不上 GitHub，检查网络后再试",
      retry: "check",
    });

    expect(view.title).toBe("更新失败");
    expect(view.sub).toBe("连不上 GitHub，检查网络后再试");
    expect(view.action).toBe("重试");
    expect(view.error).toBe(true);
  });

  it("names the latest installed version", () => {
    expect(describeUpdate({ kind: "latest", version: "0.2.1" }).sub).toBe("已是最新版本 0.2.1");
  });
});

describe("update failures", () => {
  it("turns a native code into a sentence", () => {
    expect(updateFailure({ code: "UPDATE_NETWORK" })).toBe("连不上 GitHub，检查网络后再试");
    expect(updateFailure({ code: "UPDATE_VERIFY" })).toBe("安装包校验失败，请重试");
    expect(updateFailure({ code: "UPDATE_STALE" })).toBe("下载已失效，请重新检查更新");
  });

  it("does not leak an unknown bridge message into the row", () => {
    expect(updateFailure(new Error("java.io.IOException"))).toBe("更新失败，请稍后再试");
    expect(updateFailure(null)).toBe("更新失败，请稍后再试");
  });
});
