import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWorkspaces, openRuntime } from "./workspaces";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("loadWorkspaces", () => {
  it("reads the project list and keeps only usable entries", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        current: "/work/app",
        canSwitch: true,
        canIsolate: false,
        recents: [
          { path: "/work/docs", name: "docs" },
          { path: "", name: "broken" },
          { name: "nameless" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadWorkspaces("/rt/r1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/workspaces",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(result).toEqual({
      ok: true,
      info: {
        current: "/work/app",
        canSwitch: true,
        canIsolate: false,
        recents: [{ path: "/work/docs", name: "docs" }],
      },
    });
  });

  it("carries a kernel refusal code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ code: "workspace.changing_disabled" }, 403)));
    await expect(loadWorkspaces("/rt/r1")).resolves.toEqual({
      ok: false,
      code: "workspace.changing_disabled",
    });
  });
});

describe("openRuntime", () => {
  it("opens a fresh conversation on a known root", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({ id: "r7", base: "/rt/r7", root: "/work/app", name: "app" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await openRuntime(" /work/app ");

    expect(result).toMatchObject({ ok: true, runtime: { id: "r7", base: "/rt/r7" } });
    expect(fetchMock).toHaveBeenCalledWith(
      "/runtimes",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ root: "/work/app" }),
      }),
    );
  });

  it("does not call the hub with an empty root", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(openRuntime("  ")).resolves.toEqual({ ok: false, code: "client.empty_root" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a device refusal code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ code: "device.host_only" }, 404)));
    await expect(openRuntime("/secret")).resolves.toEqual({ ok: false, code: "device.host_only" });
  });
});
