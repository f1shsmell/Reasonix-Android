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
