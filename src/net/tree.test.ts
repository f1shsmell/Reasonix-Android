import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTree } from "./tree";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("loadTree", () => {
  it("reads projects with their conversations and keeps the fields the phone draws", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json([
        {
          root: "/work/app",
          name: "app",
          open: true,
          remembered: true,
          total: 3,
          archived: 1,
          remaining: 2,
          sessions: [
            {
              path: "/work/app/s1.jsonl",
              name: "s1",
              title: "修一下登录",
              turns: 4,
              lastActiveAt: 1_700_000_000_000,
              unread: true,
              runtimeId: "r2",
            },
            { path: "", name: "broken" },
          ],
        },
        { name: "no root" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadTree({ limit: 20 });

    expect(result).toEqual({
      ok: true,
      projects: [
        {
          root: "/work/app",
          name: "app",
          open: true,
          remembered: true,
          total: 3,
          archived: 1,
          remaining: 2,
          sessions: [
            {
              path: "/work/app/s1.jsonl",
              name: "s1",
              title: "修一下登录",
              turns: 4,
              lastActiveAt: 1_700_000_000_000,
              unread: true,
              runtimeId: "r2",
            },
          ],
        },
      ],
    });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/tree?");
    expect(url).toContain("scope=active");
    expect(url).toContain("limit=20");
  });

  it("sends a per-project window when one project asked for more", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json([]));
    vi.stubGlobal("fetch", fetchMock);

    await loadTree({ limits: { "/work/app": 120 } });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(decodeURIComponent(url)).toContain('limits={"/work/app":120}');
  });

  it("carries a kernel refusal code instead of an empty tree", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ code: "device.host_only" }, 404)));
    await expect(loadTree()).resolves.toEqual({ ok: false, code: "device.host_only" });
  });

  it("reports a shape it cannot read rather than drawing nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([{ name: "no root" }])));
    await expect(loadTree()).resolves.toEqual({ ok: false, code: "tree.shape" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ projects: [] })));
    await expect(loadTree()).resolves.toEqual({ ok: false, code: "tree.shape" });
  });

  it("reports being offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network error")));
    await expect(loadTree()).resolves.toEqual({ ok: false, code: "client.offline" });
  });

  it("accepts an empty tree", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([])));
    await expect(loadTree()).resolves.toEqual({ ok: true, projects: [] });
  });
});
