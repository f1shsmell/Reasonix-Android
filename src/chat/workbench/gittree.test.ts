import { describe, expect, it } from "vitest";
import { buildTree, locate, stagedState } from "./gittree";
import type { Change } from "../../wire/changes";

const change = (over: Partial<Change> & { path: string }): Change => ({
  status: "M",
  ...over,
});

describe("buildTree", () => {
  it("puts folders before files, each in name order", () => {
    const tree = buildTree([
      change({ path: "zeta.ts" }),
      change({ path: "src/b.ts" }),
      change({ path: "src/a.ts" }),
    ]);
    expect(tree.map((node) => node.name)).toEqual(["src", "zeta.ts"]);
    const folder = tree[0];
    expect(folder?.kind).toBe("folder");
    if (folder?.kind === "folder") {
      expect(folder.children.map((node) => node.name)).toEqual(["a.ts", "b.ts"]);
    }
  });

  it("joins a folder chain with exactly one folder onto one row", () => {
    // The row names the walked folders ("a/b"); the file itself is the child.
    // The desktop's builder behaves the same way.
    const tree = buildTree([change({ path: "a/b/c.ts" })]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.kind).toBe("folder");
    if (tree[0]?.kind === "folder") {
      expect(tree[0]?.name).toBe("a/b");
      expect(tree[0]?.path).toBe("a/b");
      expect(tree[0]?.files[0]?.path).toBe("a/b/c.ts");
    }
  });

  it("sums the folder's counts over the files under it", () => {
    const tree = buildTree([
      change({ path: "a/one.ts", insertions: 3, deletions: 1 }),
      change({ path: "a/two.ts", insertions: 2 }),
    ]);
    const folder = tree[0];
    expect(folder?.kind).toBe("folder");
    if (folder?.kind === "folder") {
      expect(folder.files).toHaveLength(2);
      expect(folder.insertions).toBe(5);
      expect(folder.deletions).toBe(1);
    }
  });

  it("keeps the rename's former path on the row", () => {
    const tree = buildTree([change({ path: "new.ts", oldPath: "old.ts", status: "R" })]);
    expect(tree[0]?.kind).toBe("file");
    if (tree[0]?.kind === "file") {
      expect(tree[0].change.oldPath).toBe("old.ts");
    }
  });
});

describe("stagedState", () => {
  it("is false with nothing staged", () => {
    expect(stagedState([change({ path: "a", unstaged: true })])).toBe(false);
  });

  it("is true only when every entry is wholly staged", () => {
    expect(stagedState([change({ path: "a", staged: true })])).toBe(true);
    expect(stagedState([change({ path: "a", staged: true }), change({ path: "b", staged: true })])).toBe(true);
  });

  it("is mixed when a path is staged and still differs from the index", () => {
    expect(stagedState([change({ path: "a", staged: true, unstaged: true })])).toBe("mixed");
  });

  it("is mixed when one file is staged and another is not", () => {
    expect(
      stagedState([change({ path: "a", staged: true }), change({ path: "b", unstaged: true })]),
    ).toBe("mixed");
  });

  it("is false for an empty set", () => {
    expect(stagedState([])).toBe(false);
  });
});

describe("locate", () => {
  const repos = [
    { dir: "", name: "workspace", branch: "main" },
    { dir: "packages/app", name: "app", branch: "main" },
  ];

  it("sends a path to the deepest listed folder that contains it", () => {
    expect(locate(repos, "packages/app/src/main.ts")).toEqual({ repo: "packages/app", rel: "src/main.ts" });
  });

  it("leaves the workspace's own paths alone", () => {
    expect(locate(repos, "README.md")).toEqual({ repo: "", rel: "README.md" });
  });
});
