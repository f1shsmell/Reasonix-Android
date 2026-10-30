import { afterEach, describe, expect, it, vi } from "vitest";
import { openRuntime } from "./workspaces";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

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

  it("binds a stored conversation by naming its transcript", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({ id: "r8", base: "/rt/r8", root: "/work/app", name: "app", sessionPath: "/work/app/a.jsonl" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await openRuntime("/work/app", " /work/app/a.jsonl ");

    expect(fetchMock).toHaveBeenCalledWith(
      "/runtimes",
      expect.objectContaining({
        body: JSON.stringify({ root: "/work/app", sessionPath: "/work/app/a.jsonl" }),
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

  it("reports a runtime it cannot draw instead of opening a blank chat", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ id: "r9" })));
    await expect(openRuntime("/work/app")).resolves.toEqual({ ok: false, code: "runtime.shape" });
  });
});
