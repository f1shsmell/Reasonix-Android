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

    // A POST opens a pane of its own — the canned demo pane with its history
    // is what made every new session read as the old conversation.
    const opened = await (await fetchWithTimeout("/runtimes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: "/demo" }),
    })).json() as { id: string; base: string; sessionPath: string };
    expect(opened.id).not.toBe("demo");
    expect(opened.base).toBe(`/rt/${opened.id}`);
    expect(opened.sessionPath).toContain("/.reasonix/");

    // The fresh pane's transcript is empty, and the canned demo one is gone.
    const page = await (await fetchWithTimeout(`${opened.base}/history/page`)).json() as {
      messages: unknown[];
      total: number;
    };
    expect(page.messages).toEqual([]);
    expect(page.total).toBe(0);
  });

  it("serves the tree, status and a history page the app can fold", async () => {
    const tree = await (await fetchWithTimeout("/tree?scope=active&limit=30")).json() as { sessions: unknown[] }[];
    // POST /runtimes in an earlier test created panes the tree now knows.
    expect(tree[0]?.sessions.length).toBeGreaterThanOrEqual(3);

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