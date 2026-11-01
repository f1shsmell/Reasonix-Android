import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection } from "./connection";

/** Reachability and stream health are separate facts and must not merge. */
describe("Connection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports unauthorized rather than unreachable on a 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const connection = new Connection();
    await connection.refresh();
    expect(connection.current.reach.kind).toBe("unauthorized");
  });

  it("reports unreachable when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const connection = new Connection();
    await connection.refresh();
    const reach = connection.current.reach;
    expect(reach.kind).toBe("unreachable");
    if (reach.kind === "unreachable") expect(reach.detail).toContain("refused");
  });

  it("does not call a live link dead after one lost request", async () => {
    // A Wi-Fi that drops one packet must not flip the chip to "reconnecting":
    // this is the path that ran on every foreground and every settings visit.
    const ok = () =>
      new Response(JSON.stringify([{ id: "r1", base: "/rt/r1", root: "/w", name: "w" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    const connection = new Connection();
    await connection.refresh();
    expect(connection.current.reach.kind).toBe("ok");

    await connection.refresh();
    // One failure: the last good answer stays, and so does the runtime list.
    expect(connection.current.reach.kind).toBe("ok");
    expect(connection.current.runtimes.map((runtime) => runtime.id)).toEqual(["r1"]);

    await connection.refresh();
    expect(connection.current.reach.kind).toBe("ok");
  });

  it("reports unreachable once two requests in a row are lost", async () => {
    const ok = () =>
      new Response(JSON.stringify([{ id: "r1", base: "/rt/r1", root: "/w", name: "w" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", fetchMock);

    const connection = new Connection();
    await connection.refresh();
    await connection.refresh();
    expect(connection.current.reach.kind).toBe("ok");

    await connection.refresh();
    expect(connection.current.reach.kind).toBe("unreachable");
  });

  it("forgets earlier failures after a success", async () => {
    // The count is "in a row", not "ever": a link that recovers and then loses
    // one request is back to being tolerated, not one step from dead.
    const ok = () =>
      new Response(JSON.stringify([{ id: "r1", base: "/rt/r1", root: "/w", name: "w" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", fetchMock);

    const connection = new Connection();
    await connection.refresh();
    await connection.refresh();
    await connection.refresh();
    await connection.refresh();
    expect(connection.current.reach.kind).toBe("ok");
  });

  it("still reports a refusal at once, because that is an answer", async () => {
    // 401 is the kernel talking, not the network dropping; waiting for a
    // second read would delay the "配对失效" message the person needs.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 })),
    );
    const connection = new Connection();
    await connection.refresh();
    expect(connection.current.reach.kind).toBe("unauthorized");
  });

  it("answers whether this read reached the kernel, not what the chip shows", async () => {
    // The return value and the snapshot diverge on purpose: a caller that is
    // verifying a door must not read a kept "ok" as evidence.
    const ok = () =>
      new Response(JSON.stringify([{ id: "r1", base: "/rt/r1", root: "/w", name: "w" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", fetchMock);

    const connection = new Connection();
    await expect(connection.refresh()).resolves.toBe(true);

    // The snapshot still says ok, but the read itself did not answer.
    await expect(connection.refresh()).resolves.toBe(false);
    expect(connection.current.reach.kind).toBe("ok");
  });

  it("counts a refusal as a reset, not as a lost route", async () => {
    // Two refusals in a row must never add up to `lost`: the kernel is
    // answering, so the watch timer must not start reconnecting.
    const refused = () => new Response(null, { status: 503 });
    vi.stubGlobal("fetch", vi.fn(refused));
    const connection = new Connection();
    await connection.refresh();
    await connection.refresh();
    expect(connection.lost).toBe(false);
  });

  it("reports lost once the tolerated failures run out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    const connection = new Connection();
    await connection.refresh();
    expect(connection.lost).toBe(false);
    await connection.refresh();
    expect(connection.lost).toBe(true);
  });

  it("forgets the count when the route is replaced", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    const connection = new Connection();
    await connection.refresh();
    expect(connection.lost).toBe(false);

    // A deliberate switch starts from zero: the earlier hiccup was measured
    // on a route this phone no longer uses.
    connection.resetFailures();
    expect(connection.lost).toBe(false);
    await connection.refresh();
    expect(connection.lost).toBe(false);
  });

  it("keeps the runtime list it was given", async () => {
    const runtimes = [{ id: "r1", base: "/rt/r1", root: "/w", name: "w" }];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(runtimes), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const connection = new Connection();
    await connection.refresh();
    expect(connection.current.reach.kind).toBe("ok");
    expect(connection.current.runtimes).toEqual(runtimes);
  });

  it("refuses to attach to a runtime it does not know", () => {
    const connection = new Connection();
    connection.attach("nope");
    const stream = connection.current.stream;
    expect(stream.kind).toBe("closed");
  });

  it("notifies subscribers on every change", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
    const connection = new Connection();
    const seen: string[] = [];
    connection.subscribe((snapshot) => seen.push(snapshot.reach.kind));
    await connection.refresh();
    expect(seen).toEqual(["unknown", "ok"]);
  });

  it("does not let a slow refresh overwrite a newer one", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    );
    const connection = new Connection();
    const older = connection.refresh();
    const newer = connection.refresh();

    const body = (id: string) =>
      new Response(JSON.stringify([{ id, base: `/rt/${id}`, root: `/${id}`, name: id }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    resolvers[1]?.(body("newer"));
    await newer;
    resolvers[0]?.(body("older"));
    await older;

    expect(connection.current.runtimes.map((runtime) => runtime.id)).toEqual(["newer"]);
  });

  it("drops the previous pane's last event when the screen detaches", async () => {
    class Source {
      static latest: Source | null = null;
      onopen: (() => void) | null = null;
      onmessage: ((message: { data: string; lastEventId: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        Source.latest = this;
      }
      close() {}
    }
    vi.stubGlobal("EventSource", Source);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ id: "r1", base: "/rt/r1", root: "/w", name: "w" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const connection = new Connection();
    await connection.refresh();
    connection.attach("r1");
    Source.latest?.onmessage?.({
      data: JSON.stringify({ kind: "text", text: "from A" }),
      lastEventId: "1",
    });
    expect(connection.current.lastEvent).toEqual({ kind: "text", text: "from A" });

    connection.detach();
    expect(connection.current.lastEvent).toBeUndefined();
  });
});
