import { afterEach, describe, expect, it, vi } from "vitest";
import { placeProject, pinnedFirst, setPinned, treeWriteMessage } from "./pin";
import type { TreeSession } from "../wire/tree";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

function session(path: string, pinned?: boolean): TreeSession {
  return { path, name: path, ...(pinned === true ? { pinned: true } : {}) };
}

describe("setPinned", () => {
  it("posts the path and the wanted state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(setPinned(" /work/app/a.jsonl ", true)).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "/tree/sessions/pin",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ path: "/work/app/a.jsonl", pinned: true }),
      }),
    );
  });

  it("sends the unpin as the same request with false", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await setPinned("/work/app/a.jsonl", false);

    expect(fetchMock).toHaveBeenCalledWith(
      "/tree/sessions/pin",
      expect.objectContaining({ body: JSON.stringify({ path: "/work/app/a.jsonl", pinned: false }) }),
    );
  });

  it("does not post an empty path", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(setPinned("   ", true)).resolves.toEqual({ ok: false, code: "client.empty_path" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the kernel's refusal code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ code: "session.outside_workspace" }, 403)),
    );
    await expect(setPinned("/etc/passwd", true)).resolves.toEqual({
      ok: false,
      code: "session.outside_workspace",
    });
  });

  it("reports being offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    await expect(setPinned("/a.jsonl", true)).resolves.toEqual({
      ok: false,
      code: "client.offline",
    });
  });
});

describe("placeProject", () => {
  it("names the project to land before rather than a step", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await placeProject("/work/app", "/work/docs");

    expect(fetchMock).toHaveBeenCalledWith(
      "/tree/workspaces/move",
      expect.objectContaining({
        body: JSON.stringify({ path: "/work/app", before: "/work/docs" }),
      }),
    );
  });

  it("sends an empty before for the end of the list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await placeProject("/work/app", "");

    expect(fetchMock).toHaveBeenCalledWith(
      "/tree/workspaces/move",
      expect.objectContaining({ body: JSON.stringify({ path: "/work/app", before: "" }) }),
    );
  });

  it("keeps the kernel's refusal code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ code: "workspace.not_remembered" }, 404)),
    );
    await expect(placeProject("/work/app", "")).resolves.toEqual({
      ok: false,
      code: "workspace.not_remembered",
    });
  });
});

describe("pinnedFirst", () => {
  it("leads with the pinned rows, keeping each group's order", () => {
    const rows = [session("a"), session("b", true), session("c"), session("d", true)];
    expect(pinnedFirst(rows).map((row) => row.path)).toEqual(["b", "d", "a", "c"]);
  });

  it("returns the same array when nothing is pinned", () => {
    // The tree hands out a fresh array per read; when no pin exists there is
    // nothing to reorder and the caller's copy should stay as it is.
    const rows = [session("a"), session("b")];
    expect(pinnedFirst(rows)).toBe(rows);
  });

  it("handles a list that is entirely pinned", () => {
    const rows = [session("a", true), session("b", true)];
    expect(pinnedFirst(rows).map((row) => row.path)).toEqual(["a", "b"]);
  });

  it("answers nothing for an empty list", () => {
    expect(pinnedFirst([])).toEqual([]);
  });
});

describe("treeWriteMessage", () => {
  it("names each refusal in a sentence", () => {
    expect(treeWriteMessage("client.offline")).toContain("连不上");
    expect(treeWriteMessage("session.outside_workspace")).toContain("不在已知项目");
    expect(treeWriteMessage("workspace.not_remembered")).toContain("没有被记住");
    expect(treeWriteMessage("something.new")).toContain("something.new");
  });
});
