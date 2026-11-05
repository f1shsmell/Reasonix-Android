import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { UpdateRow } from "./UpdateRow";
import type { UpdateStatus } from "./update";

let container: HTMLDivElement;
let root: Root | null = null;
let onAction: Mock<() => void>;

function render(status: UpdateStatus): void {
  act(() => {
    root?.render(<UpdateRow status={status} onAction={onAction} />);
  });
}

function row(): HTMLButtonElement {
  const element = container.querySelector("button.update-setting");
  if (!element) throw new Error("no update row");
  return element as HTMLButtonElement;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onAction = vi.fn<() => void>();
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = null;
});

describe("UpdateRow", () => {
  it("offers a new release and hands the tap to the state machine", () => {
    render({
      kind: "available",
      version: "0.2.2",
      versionCode: 12,
      url: "https://example.test/app.apk",
      mirrors: [],
      notes: "修复连接\n- 第二条",
    });

    expect(container.textContent).toContain("发现新版本 0.2.2");
    expect(container.textContent).toContain("下载");
    act(() => row().click());
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("draws the meter and refuses taps while downloading", () => {
    render({
      kind: "downloading",
      version: "0.2.2",
      transferred: 512 * 1024,
      total: 1024 * 1024,
    });

    expect(row().disabled).toBe(true);
    expect(row().querySelector(".update-meter > span")?.getAttribute("style")).toContain(
      "width: 50%",
    );
    act(() => row().click());
    expect(onAction).not.toHaveBeenCalled();
  });

  it("continues into the installer after the permission detour", () => {
    render({ kind: "permission", version: "0.2.2" });

    expect(container.textContent).toContain("继续安装");
    act(() => row().click());
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("marks a failure and offers a retry", () => {
    render({ kind: "error", message: "安装包下载失败，稍后再试", retry: "install" });

    expect(row().className).toContain("error");
    expect(container.textContent).toContain("安装包下载失败，稍后再试");
    expect(container.textContent).toContain("重试");
  });

  it("shows the installed version when there is nothing to do", () => {
    render({ kind: "latest", version: "0.2.1" });

    expect(container.textContent).toContain("已是最新版本 0.2.1");
    expect(container.textContent).toContain("重新检查");
  });

  it("opens the whole note, because the row only fits one cut sentence", () => {
    const notes = ["# 0.2.7", "", "这一版收了三处小毛病。", "", "## 修复", "", "- 状态栏"].join("\n");
    render({
      kind: "available",
      version: "0.2.7",
      versionCode: 17,
      url: "https://example.test/app.apk",
      mirrors: [],
      notes,
    });

    // The row keeps its one-line summary, which is cut where the note wraps.
    expect(container.querySelector("[role='dialog']")).toBeNull();
    const opener = container.querySelector("button.update-notes-setting");
    expect(opener?.textContent).toContain("查看完整更新说明");

    act(() => (opener as HTMLButtonElement).click());

    const dialog = container.querySelector("[role='dialog']");
    expect(dialog?.getAttribute("aria-label")).toBe("0.2.7 更新说明");
    // The full body, not the truncated summary.
    expect(dialog?.textContent).toContain("这一版收了三处小毛病。");
    expect(dialog?.textContent).toContain("状态栏");
  });

  it("offers no note door when the release carries no notes", () => {
    render({
      kind: "available",
      version: "0.2.7",
      versionCode: 17,
      url: "https://example.test/app.apk",
      mirrors: [],
      notes: "   ",
    });

    expect(container.querySelector("button.update-notes-setting")).toBeNull();
  });
});
