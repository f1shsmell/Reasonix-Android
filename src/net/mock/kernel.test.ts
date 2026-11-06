import { describe, expect, it } from "vitest";
import { installMockKernel } from "./kernel";
import { fetchWithTimeout } from "../http";

/**
 * The mock kernel lives behind the same transport the endpoint modules use.
 * These checks pin the routes the dev shell needs, not the UI's own parsing.
 */
describe("mock kernel", () => {
  installMockKernel();

  it("answers the hub list and opens a pane with a single runtime", async () => {
    const list = await (await fetchWithTimeout("/runtimes")).json() as { id: string; base: string }[];
    expect(list[0]?.id).toBe("demo");

    const opened = await (await fetchWithTimeout("/runtimes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: "/demo" }),
    })).json() as { id: string; base: string };
    expect(opened).toMatchObject({ id: "demo", base: "/rt/demo" });
  });

  it("serves the tree, status and a history page the app can fold", async () => {
    const tree = await (await fetchWithTimeout("/tree?scope=active&limit=30")).json() as { sessions: unknown[] }[];
    expect(tree[0]?.sessions).toHaveLength(3);

    const status = await (await fetchWithTimeout("/rt/demo/status")).json() as { running: boolean; decisions: unknown[] };
    expect(status.running).toBe(false);
    expect(status.decisions).toEqual([]);

    const page = await (await fetchWithTimeout("/rt/demo/history/page?limit=20")).json() as {
      messages: unknown[];
      total: number;
      hasMoreBefore: boolean;
    };
    expect(page.messages).toHaveLength(4);
    expect(page.total).toBe(4);
    expect(page.hasMoreBefore).toBe(false);
  });
});