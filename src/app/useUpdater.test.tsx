import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdater } from "./useUpdater";
import type { UpdateStatus } from "./update";

const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  launchInstaller: vi.fn(),
  onUpdateProgress: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("../native/update", () => ({
  checkForUpdate: mocks.checkForUpdate,
  installUpdate: mocks.installUpdate,
  launchInstaller: mocks.launchInstaller,
  onUpdateProgress: mocks.onUpdateProgress,
}));

const check = {
  update: true,
  tag: "v0.2.2",
  version: "0.2.2",
  versionCode: 12,
  apk: "reasonix-for-android-0.2.2.apk",
  url: "https://github.com/f1shsmell/Reasonix-Android/releases/download/v0.2.2/app.apk",
  mirrors: ["https://gh-proxy.com/https://github.com/f1shsmell/Reasonix-Android/app.apk"],
  notes: "修复连接",
  installedVersion: "0.2.1",
  installedCode: 11,
};

let container: HTMLDivElement;
let root: Root | null = null;
let current: { status: UpdateStatus; act: () => void } | null = null;

function Probe({ enabled }: { enabled: boolean }) {
  current = useUpdater(enabled);
  return <span data-status={current.status.kind} />;
}

async function render(enabled = true): Promise<void> {
  await act(async () => {
    root?.render(<Probe enabled={enabled} />);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  current = null;
  vi.clearAllMocks();
  mocks.onUpdateProgress.mockResolvedValue({ remove: vi.fn(async () => {}) });
  mocks.checkForUpdate.mockResolvedValue(check);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = null;
});

describe("useUpdater", () => {
  it("checks once when the pane opens and offers the release", async () => {
    await render(true);
    await flush();

    expect(mocks.checkForUpdate).toHaveBeenCalledWith(false);
    expect(current?.status.kind).toBe("available");
  });

  it("does not ask GitHub while the pane is closed", async () => {
    await render(false);
    await flush();

    expect(mocks.checkForUpdate).not.toHaveBeenCalled();
    expect(current?.status.kind).toBe("idle");
  });

  it("downloads the release it found and follows the progress event", async () => {
    let progress: ((value: { transferred: number; total: number }) => void) | null = null;
    mocks.onUpdateProgress.mockImplementation(async (listener: typeof progress) => {
      progress = listener;
      return { remove: vi.fn(async () => {}) };
    });
    let finish: ((value: { state: "downloaded" }) => void) | null = null;
    mocks.installUpdate.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    await render(true);
    await flush();
    act(() => current?.act());
    await flush();

    expect(mocks.installUpdate).toHaveBeenCalledWith(check.url, check.mirrors, check.versionCode);
    expect(current?.status.kind).toBe("downloading");

    act(() => progress?.({ transferred: 512, total: 1024 }));
    expect(current?.status).toMatchObject({ kind: "downloading", transferred: 512, total: 1024 });

    act(() => finish?.({ state: "downloaded" }));
    await flush();
    expect(current?.status.kind).toBe("downloaded");
  });

  it("turns a failed check into a sentence and retries on force", async () => {
    mocks.checkForUpdate.mockRejectedValue({ code: "UPDATE_NETWORK" });

    await render(true);
    await flush();

    expect(current?.status).toMatchObject({
      kind: "error",
      message: "连不上 GitHub，检查网络后再试",
      retry: "check",
    });

    mocks.checkForUpdate.mockResolvedValue({ ...check, update: false, installedVersion: "0.2.1" });
    act(() => current?.act());
    await flush();

    expect(mocks.checkForUpdate).toHaveBeenLastCalledWith(true);
    expect(current?.status).toMatchObject({ kind: "latest", version: "0.2.1" });
  });

  it("keeps the downloaded file when the installer permission is missing", async () => {
    mocks.launchInstaller.mockResolvedValue({ state: "permission" });

    await render(true);
    await flush();
    mocks.installUpdate.mockResolvedValue({ state: "permission" });
    act(() => current?.act());
    await flush();

    expect(current?.status).toMatchObject({ kind: "permission", version: "0.2.2" });

    act(() => current?.act());
    await flush();
    expect(mocks.launchInstaller).toHaveBeenCalledTimes(1);
    expect(current?.status).toMatchObject({ kind: "permission", version: "0.2.2" });
  });
});
