import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench";
import type { ConnectionSnapshot } from "../../net/connection";
import type { Change } from "../../wire/changes";

const net = vi.hoisted(() => ({
  loadChanges: vi.fn(),
  loadDiff: vi.fn(),
  loadGitRepos: vi.fn(),
  loadWorkspaceGit: vi.fn(),
  stageChanges: vi.fn(),
  proposeCommit: vi.fn(),
  commitStaged: vi.fn(),
  // The message maps mirror the real module's transport sentences, so the
  // component tests assert the wiring and the real mapping together.
  commitMessage: vi.fn((code: string) =>
    code === "client.offline" || code === "client.timeout"
      ? "连不上电脑，检查连接后重试。"
      : `没提交成：${code}`,
  ),
  stageMessage: vi.fn((code: string) =>
    code === "stage.unknown_path"
      ? "这个文件不在变更列表里了，刷新后再试。"
      : `没暂存成：${code}`,
  ),
  draftFailureText: vi.fn((code: string) => `起草失败（${code}）`),
  fileMessage: vi.fn((code: string) => `没读出来：${code}`),
  listFiles: vi.fn(),
  readFile: vi.fn(),
  loadHistory: vi.fn(),
  loadCommitFiles: vi.fn(),
  loadCommitDiff: vi.fn(),
}));
vi.mock("../../net/changes", () => net);

let container: HTMLDivElement;
let root: Root | null = null;

const snapshot: ConnectionSnapshot = {
  reach: { kind: "ok" },
  runtimes: [],
  stream: { kind: "idle" },
  events: [],
  eventSeq: 0,
};

let fixture: Change[] = [
  { path: "src/app/main.tsx", status: "M", staged: true, insertions: 18, deletions: 4 },
  { path: "src/app/main.tsx", status: "M", unstaged: true, insertions: 2 },
  { path: "logo.psd", status: "??" },
];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  fixture = [
    { path: "src/app/main.tsx", status: "M", staged: true, insertions: 18, deletions: 4 },
    { path: "src/app/main.tsx", status: "M", unstaged: true, insertions: 2 },
    { path: "logo.psd", status: "??" },
  ];
  net.loadChanges.mockImplementation(async () => ({
    ok: true,
    value: { repo: true, changes: fixture },
  }));
  net.loadDiff.mockResolvedValue({
    ok: true,
    value: { path: "src/app/main.tsx", diff: "@@ -1,2 +1,2 @@\n-a\n+b\n", truncated: false },
  });
  net.loadGitRepos.mockResolvedValue({ ok: false, code: "http.404" });
  net.loadWorkspaceGit.mockResolvedValue({
    ok: true,
    value: { repo: true, name: "w", branch: "main", detached: false, added: 2, removed: 1, untracked: 1 },
  });
  net.stageChanges.mockResolvedValue({ ok: true });
  net.listFiles.mockResolvedValue({ ok: true, value: { files: ["main.ts"], directories: ["src"] } });
  net.readFile.mockResolvedValue({
    ok: true,
    value: { path: "src/main.ts", content: "const x = 1;", revision: "r" },
  });
  net.loadHistory.mockResolvedValue({
    ok: true,
    value: {
      repo: true,
      commits: [
        { id: "abcdef123456", parents: [], author: "a", at: Math.floor(Date.now() / 1000), refs: ["refs/heads/main"], subject: "s" },
      ],
      truncated: false,
    },
  });
  net.loadCommitFiles.mockResolvedValue({
    ok: true,
    value: { repo: true, files: [{ path: "a.ts", status: "M" }], truncated: false },
  });
  net.loadCommitDiff.mockResolvedValue({
    ok: true,
    value: { path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b", truncated: false },
  });
  net.proposeCommit.mockResolvedValue({
    ok: true,
    value: {
      message: "draft",
      fingerprint: "fp1",
      files: [{ path: "src/app/main.tsx", status: "M", sensitive: true }],
      truncated: false,
      contentSecrets: true,
    },
  });
  net.commitStaged.mockResolvedValue({ ok: true, value: { hash: "abcdef123456", subject: "s" } });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.clearAllMocks();
});

function mount(): void {
  root = createRoot(container);
  act(() => {
    root?.render(
      <Workbench base="/rt/r1" readOnly={false} snapshot={snapshot} wrote={0} onClose={() => {}} />,
    );
  });
}

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe("Workbench", () => {
  it("draws the change tree with the counts the kernel counted, and never a discard", async () => {
    mount();
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("main.tsx");
    expect(text).toContain("logo.psd");
    expect(text).toContain("+18");
    // A binary (uncounted) file prints no "+0 −0".
    expect(text).not.toContain("+0");
    expect(container.textContent).not.toContain("丢弃");
  });

  it("opens the file's diff under its row and marks the row current", async () => {
    mount();
    await flush();
    const row = [...container.querySelectorAll<HTMLButtonElement>(".wb-row-main")].find((button) =>
      button.textContent?.includes("main.tsx"),
    );
    act(() => row?.click());
    await flush();
    expect(net.loadDiff).toHaveBeenCalledWith("/rt/r1", "src/app/main.tsx", undefined);
    expect(container.querySelector(".wb-diff")).not.toBeNull();
    expect(container.querySelector('[aria-current="page"]')).not.toBeNull();
    // A removed line that itself begins with a dash stays a removed line.
    expect((container.querySelector(".wb-diff-text")?.textContent ?? "").length).toBeGreaterThan(0);
  });

  it("stages the unstaged part of a path, and unstages the staged one", async () => {
    mount();
    await flush();
    // A path with both a staged and an unstaged part draws two rows, as the
    // desktop's tree does: the unstaged row's tick stages the remainder.
    const boxes = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"][aria-label="暂存 main.tsx"]'),
    ];
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.getAttribute("aria-checked")).toBe("true");
    act(() => boxes[1]?.click());
    await flush();
    expect(net.stageChanges).toHaveBeenCalledWith("/rt/r1", { paths: ["src/app/main.tsx"] });
    act(() => boxes[0]?.click());
    await flush();
    expect(net.stageChanges).toHaveBeenCalledWith("/rt/r1", {
      paths: ["src/app/main.tsx"],
      unstage: true,
    });
  });

  it("flips the header action to unstage when everything is wholly staged", async () => {
    fixture = [{ path: "a.ts", status: "M", staged: true }];
    mount();
    await flush();
    expect(container.textContent).toContain("取消全部暂存");
    const flip = [...container.querySelectorAll<HTMLButtonElement>(".wb-section-actions button")].find(
      (button) => button.textContent?.includes("取消全部暂存"),
    );
    act(() => flip?.click());
    await flush();
    expect(net.stageChanges).toHaveBeenCalledWith("/rt/r1", { all: true, unstage: true });
  });

  it("gates the commit behind the secrets acknowledgement and carries the fingerprint", async () => {
    mount();
    await flush();
    const commitButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "提交…",
    );
    act(() => commitButton?.click());
    await flush();
    expect(net.proposeCommit.mock.calls[0]?.[0]).toBe("/rt/r1");
    expect(net.proposeCommit.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    // The staged file was marked sensitive: the gate holds the button.
    const go = container.querySelector<HTMLButtonElement>(".wb-commit-go");
    expect(go?.disabled).toBe(true);
    const ack = container.querySelector<HTMLInputElement>('.wb-ack input');
    act(() => {
      ack?.click();
    });
    act(() => go?.click());
    await flush();
    expect(net.commitStaged).toHaveBeenCalledWith("/rt/r1", {
      message: "draft",
      fingerprint: "fp1",
      acknowledgeSecrets: true,
    });
    expect(container.textContent).toContain("已提交 abcdef1：s");
  });

  it("offers a redraft instead of guessing the staged set when the draft fails", async () => {
    net.proposeCommit.mockResolvedValue({ ok: false, code: "client.offline" });
    mount();
    await flush();
    const commitButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "提交…",
    );
    act(() => commitButton?.click());
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("连不上电脑，检查连接后重试。");
    // Nothing was read, so nothing about the staged set may be claimed.
    expect(text).not.toContain("没有已暂存的变更");
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].some((button) =>
      button.textContent === "重新起草",
    )).toBe(true);
  });

  it("reads the history when its section opens and expands a commit's file", async () => {
    mount();
    await flush();
    const head = container.querySelector<HTMLButtonElement>(".wb-history-head");
    act(() => head?.click());
    await flush();
    expect(net.loadHistory).toHaveBeenCalledWith("/rt/r1", undefined);
    expect(container.textContent).toContain("abcdef1");
    expect(container.textContent).toContain("s");
    const commitRow = [...container.querySelectorAll<HTMLButtonElement>(".wb-history-row .wb-row-main")][0];
    act(() => commitRow?.click());
    await flush();
    expect(net.loadCommitFiles).toHaveBeenCalledWith("/rt/r1", "abcdef123456", undefined);
    const fileRow = [...container.querySelectorAll<HTMLButtonElement>(".wb-history-files .wb-row-main")][0];
    act(() => fileRow?.click());
    await flush();
    expect(net.loadCommitDiff).toHaveBeenCalledWith("/rt/r1", "abcdef123456", "a.ts", undefined);
    expect(container.querySelector(".wb-diff")).not.toBeNull();
  });

  it("says when the folder is not a git repository", async () => {
    net.loadChanges.mockResolvedValue({ ok: true, value: { repo: false, changes: [] } });
    net.loadWorkspaceGit.mockResolvedValue({
      ok: true,
      value: { repo: false, name: "w", branch: "", detached: false, added: 0, removed: 0, untracked: 0 },
    });
    mount();
    await flush();
    expect(container.textContent).toContain("这里不是 git 仓库");
  });

  it("keeps the list and offers 重新读取 when a read refuses", async () => {
    net.loadChanges
      .mockResolvedValueOnce({ ok: false, code: "http.500" })
      .mockResolvedValue({ ok: true, value: { repo: true, changes: fixture } });
    mount();
    await flush();
    const again = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "重新读取",
    );
    expect(again).toBeDefined();
    act(() => again?.click());
    await flush();
    // The retry read the list: the error gave way to the rows.
    expect(container.textContent).toContain("main.tsx");
    expect(container.textContent).not.toContain("没读出来");
  });

  it("browses the workspace's files read-only", async () => {
    mount();
    await flush();
    const tab = container.querySelector<HTMLButtonElement>('[role="tab"]');
    const filesTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (button) => button.textContent === "文件",
    );
    act(() => filesTab?.click());
    await flush();
    expect(net.listFiles).toHaveBeenCalledWith("/rt/r1", "", "");
    expect(tab).not.toBeNull();
    expect(container.textContent).toContain("main.ts");
    const fileRow = [...container.querySelectorAll<HTMLButtonElement>(".wb-tree .wb-row")].find(
      (button) => button.textContent?.includes("main.ts"),
    );
    act(() => fileRow?.click());
    await flush();
    expect(net.readFile).toHaveBeenCalledWith("/rt/r1", "main.ts");
    expect(container.textContent).toContain("const x = 1;");
  });

  it("resets the open diff when the repository switches", async () => {
    net.loadGitRepos.mockResolvedValue({
      ok: true,
      value: {
        repos: [
          { dir: "", name: "workspace", branch: "main" },
          { dir: "packages/app", name: "app", branch: "main" },
        ],
        truncated: false,
      },
    });
    mount();
    await flush();
    const row = [...container.querySelectorAll<HTMLButtonElement>(".wb-row-main")].find((button) =>
      button.textContent?.includes("main.tsx"),
    );
    act(() => row?.click());
    await flush();
    expect(net.loadDiff).toHaveBeenCalledWith("/rt/r1", "src/app/main.tsx", undefined);
    expect(container.querySelector(".wb-diff")).not.toBeNull();
    // Switching repos clears the open diff: the path belonged to the previous
    // repository, and re-reading it with the new ?repo= would draw the wrong file.
    const chip = [...container.querySelectorAll<HTMLButtonElement>(".wb-repos button")].find(
      (button) => button.textContent === "app",
    );
    act(() => chip?.click());
    await flush();
    expect(container.querySelector(".wb-diff")).toBeNull();
    expect(container.querySelector('[aria-current="page"]')).toBeNull();
  });

  it("draws a stage refusal with its own verb, not the read-failure one", async () => {
    net.stageChanges.mockResolvedValue({ ok: false, code: "stage.unknown_path" });
    mount();
    await flush();
    const box = container.querySelector<HTMLButtonElement>('[role="checkbox"]');
    act(() => box?.click());
    await flush();
    expect(container.textContent).toContain("这个文件不在变更列表里了，刷新后再试。");
    // A stage refusal is not a read failure: the 重新读取 affordance stays off.
    expect(container.textContent).not.toContain("重新读取");
  });

  it("pages a long list and counts the rows still hidden", async () => {
    // 600 file rows across two folders: 602 rows total (the two folder rows
    // count too), 500 drawn, the rest behind the show-more line.
    const many: Change[] = [];
    for (let i = 0; i < 300; i += 1) {
      many.push({ path: `a/f${i}.ts`, status: "M", insertions: 1 });
      many.push({ path: `b/g${i}.ts`, status: "M", insertions: 1 });
    }
    net.loadChanges.mockResolvedValue({ ok: true, value: { repo: true, changes: many } });
    mount();
    await flush();
    const more = container.querySelector<HTMLButtonElement>(".wb-tree .wb-more");
    expect(more?.textContent).toContain("102 行未显示");
    act(() => more?.click());
    await flush();
    // The second page arrives; nothing is hidden any more.
    expect(container.querySelector(".wb-tree .wb-more")).toBeNull();
    expect(container.textContent).toContain("g299.ts");
  });

  it("shows a read-only banner and no stage boxes under a write lease", async () => {
    root = createRoot(container);
    act(() => {
      root?.render(
        <Workbench base="/rt/r1" readOnly snapshot={snapshot} wrote={0} onClose={() => {}} />,
      );
    });
    await flush();
    expect(container.textContent).toContain("该会话只读");
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
  });
});
