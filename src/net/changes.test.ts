import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitStaged,
  listFiles,
  loadChanges,
  loadCommitDiff,
  loadCommitFiles,
  loadDiff,
  loadGitRepos,
  loadHistory,
  loadWorkspaceGit,
  proposeCommit,
  readFile,
  stageChanges,
} from "./changes";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function refusal(status: number, code: string): Response {
  return new Response(JSON.stringify({ code }), { status });
}

describe("changes reads", () => {
  it("loadChanges reads the pane's change list", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/rt/r1/changes");
      return ok({ repo: true, changes: [{ path: "a.ts", status: "M", staged: true }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const reply = await loadChanges("/rt/r1");
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.value.repo).toBe(true);
      expect(reply.value.changes).toHaveLength(1);
    }
  });

  it("loadChanges carries the repo query for a nested repository", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/rt/r1/changes?repo=packages%2Fapp");
      return ok({ repo: true, changes: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await loadChanges("/rt/r1", "packages/app");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("loadDiff names the path and reports truncation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok({ path: "a.ts", diff: "@@ -1 +1 @@", truncated: true })),
    );
    const reply = await loadDiff("/rt/r1", "a.ts");
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.value.diff).toContain("@@");
      expect(reply.value.truncated).toBe(true);
    }
  });

  it("loadWorkspaceGit and loadHistory answer for the identity and the log", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/rt/r1/workspace/git") {
          return ok({ repo: true, name: "n", branch: "main", detached: false, added: 1, removed: 0, untracked: 0 });
        }
        if (url === "/rt/r1/workspace/git/log?limit=100") {
          // The second commit has an empty message (`--allow-empty-message`):
          // it stays in the list rather than vanishing.
          return ok({
            repo: true,
            commits: [
              { id: "abc", parents: [], author: "a", at: 1, refs: [], subject: "s" },
              { id: "empty", parents: ["abc"], author: "a", at: 2, refs: [], subject: "" },
            ],
          });
        }
        return refusal(404, "workspace.path_outside_tree");
      }),
    );
    const git = await loadWorkspaceGit("/rt/r1");
    expect(git.ok && git.value.branch).toBe("main");
    const history = await loadHistory("/rt/r1");
    expect(history.ok && history.value.commits).toHaveLength(2);
    if (history.ok) expect(history.value.commits[1]?.subject).toBe("");
  });

  it("loadGitRepos keeps a repo whose identity read failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ok({
          repos: [
            // The kernel fills the row even when gitstatus.Identity errs: the
            // nested repo is real, its name just did not come back.
            { dir: "packages/api", name: "", branch: "" },
            { dir: "packages/app", name: "app", branch: "main" },
          ],
          truncated: false,
        }),
      ),
    );
    const reply = await loadGitRepos("/rt/r1");
    expect(reply.ok && reply.value.repos).toHaveLength(2);
  });

  it("loadCommitFiles and loadCommitDiff ride the git prefix", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/rt/r1/git/commit?id=abc") {
        return ok({ repo: true, files: [{ path: "a.ts", status: "M" }] });
      }
      if (url === "/rt/r1/git/commit/diff?id=abc&path=a.ts") {
        return ok({ path: "a.ts", diff: "@@ -1 +1 @@", truncated: false });
      }
      return refusal(400, "git.repo_unknown");
    });
    vi.stubGlobal("fetch", fetchMock);
    const files = await loadCommitFiles("/rt/r1", "abc");
    expect(files.ok && files.value.files[0]?.path).toBe("a.ts");
    const diff = await loadCommitDiff("/rt/r1", "abc", "a.ts");
    expect(diff.ok && diff.value.diff).toContain("@@");
  });

  it("listFiles and readFile answer the browser", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/rt/r1/workspace/files?path=src") {
          return ok({ files: ["main.ts"], directories: [] });
        }
        if (url === "/rt/r1/workspace/file?path=src%2Fmain.ts") {
          return ok({ path: "src/main.ts", content: "const x = 1;", revision: "r" });
        }
        return refusal(400, "workspace.file_unreadable");
      }),
    );
    const listing = await listFiles("/rt/r1", "src");
    expect(listing.ok && listing.value.files).toEqual(["main.ts"]);
    const file = await readFile("/rt/r1", "src/main.ts");
    expect(file.ok && file.value.content).toContain("const x");
  });

  it("a refusal carries the kernel's dotted code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => refusal(400, "changes.path_outside_tree")));
    const reply = await loadDiff("/rt/r1", "../outside");
    expect(reply).toEqual({ ok: false, code: "changes.path_outside_tree" });
  });

  it("a non-JSON refusal degrades to the HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const reply = await loadChanges("/rt/r1");
    expect(reply).toEqual({ ok: false, code: "http.500" });
  });

  it("a dead socket reads as client.offline", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("down");
    }));
    expect(await loadChanges("/rt/r1")).toEqual({ ok: false, code: "client.offline" });
  });

  it("a deadline reads as client.timeout, not offline", async () => {
    // The kernel running numstat on a cold cache can outlive the 12s read;
    // telling that person "连不上电脑" would send them chasing the wrong fix.
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>(() => {})));
    const reply = loadChanges("/rt/r1");
    const assertion = expect(reply).resolves.toEqual({ ok: false, code: "client.timeout" });
    await vi.advanceTimersByTimeAsync(12_001);
    await assertion;
  });

  it("a 200 that is not JSON is a shape refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200 })));
    expect(await loadChanges("/rt/r1")).toEqual({ ok: false, code: "changes.shape" });
  });
});

describe("changes writes", () => {
  it("stageChanges posts the request and reads the 204", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/rt/r1/changes/stage");
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toBe(JSON.stringify({ paths: ["a.ts"] }));
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const reply = await stageChanges("/rt/r1", { paths: ["a.ts"] });
    expect(reply).toEqual({ ok: true });
  });

  it("unstage rides the same route with the flag set", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(init?.body)).toBe(JSON.stringify({ all: true, unstage: true }));
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await stageChanges("/rt/r1", { all: true, unstage: true });
  });

  it("a stage refusal names the kernel's code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => refusal(400, "stage.unknown_path")));
    expect(await stageChanges("/rt/r1", { paths: ["gone.ts"] })).toEqual({
      ok: false,
      code: "stage.unknown_path",
    });
  });

  it("proposeCommit posts nothing but the query and parses the proposal", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/rt/r1/commit/propose?repo=app");
      expect(init?.method).toBe("POST");
      return ok({
        message: "draft",
        fingerprint: "fp",
        files: [{ path: "a.ts", status: "M", sensitive: true }],
        truncated: false,
        contentSecrets: false,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const reply = await proposeCommit("/rt/r1", "app");
    expect(reply.ok && reply.value.fingerprint).toBe("fp");
  });

  it("commitStaged sends the fingerprint and the secrets acknowledgement", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/rt/r1/commit");
      expect(String(init?.body)).toBe(
        JSON.stringify({ message: "m", fingerprint: "fp", acknowledgeSecrets: true }),
      );
      return ok({ hash: "abcdef123456", subject: "s" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const reply = await commitStaged("/rt/r1", {
      message: "m",
      fingerprint: "fp",
      acknowledgeSecrets: true,
    });
    expect(reply.ok && reply.value.hash).toBe("abcdef123456");
  });

  it("commitStaged reports a moved index by its code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => refusal(409, "commit.staged_changed")));
    expect(
      await commitStaged("/rt/r1", { message: "m", fingerprint: "fp" }),
    ).toEqual({ ok: false, code: "commit.staged_changed" });
  });
});
