import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection } from "./connection";

afterEach(() => vi.unstubAllGlobals());

describe("Connection shape guards", () => {
  it("reports a malformed /runtimes body as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: "proxy.bad_response" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const connection = new Connection();
    await connection.refresh();
    expect(connection.current.reach.kind).toBe("unreachable");
  });

  it("keeps the usable rows when one runtime is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            { id: "r1", base: "/rt/r1", root: "/work", name: "work" },
            { id: 2, base: null },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const connection = new Connection();
    await connection.refresh();
    expect(connection.current.reach.kind).toBe("ok");
    expect(connection.current.runtimes.map((runtime) => runtime.id)).toEqual(["r1"]);
  });
});
