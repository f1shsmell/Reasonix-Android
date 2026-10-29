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
});
