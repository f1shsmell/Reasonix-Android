import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSheet } from "./ModelSheet";

/**
 * The sheet is read on open and switches this pane only.
 *
 * Two behaviours carry it: the active model cannot be picked again (a tap that
 * re-posts the current ref is a request the kernel would refuse or no-op), and
 * a refusal is shown rather than swallowed, because the person chose a model
 * and needs to know why it did not take.
 */

let container: HTMLDivElement;
let root: Root | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function route(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const catalog = {
  current: "deepseek/deepseek-flash",
  label: "DeepSeek Flash",
  default: "deepseek/deepseek-pro",
  models: [
    {
      ref: "deepseek/deepseek-flash",
      provider: "deepseek",
      model: "deepseek-flash",
      active: true,
      efforts: ["low", "high"],
      vision: true,
      contextWindow: 128000,
    },
    {
      ref: "deepseek/deepseek-pro",
      provider: "deepseek",
      model: "deepseek-pro",
      default: true,
      contextWindow: 64000,
    },
  ],
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function render(props: Partial<React.ComponentProps<typeof ModelSheet>> = {}): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root?.render(<ModelSheet base="/rt/r1" onClose={() => {}} onSwitched={() => {}} {...props} />);
  });
  await settle();
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function rows(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll(".model-row")) as HTMLButtonElement[];
}

describe("ModelSheet", () => {
  it("lists the catalog with what each model can do", async () => {
    route(() => json(catalog));
    await render();

    expect(rows()).toHaveLength(2);
    expect(container.textContent).toContain("deepseek-flash");
    expect(container.textContent).toContain("128K 上下文");
    expect(container.textContent).toContain("看图");
    expect(container.textContent).toContain("思考 low/high");
    expect(container.textContent).toContain("默认");
  });

  it("marks the model this conversation is on and refuses to re-pick it", async () => {
    route(() => json(catalog));
    await render();

    const active = rows().find((row) => row.textContent?.includes("deepseek-flash"));
    expect(active?.getAttribute("aria-pressed")).toBe("true");
    expect(active?.disabled).toBe(true);
  });

  it("switches to another model and closes through the caller", async () => {
    const fetchMock = route((_url, init) => {
      if (init?.method === "POST") return new Response(null, { status: 204 });
      return json(catalog);
    });
    const onSwitched = vi.fn();
    await render({ onSwitched });

    await act(async () => {
      rows()
        .find((row) => row.textContent?.includes("deepseek-pro"))
        ?.click();
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/model",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ ref: "deepseek/deepseek-pro" }) }),
    );
    expect(onSwitched).toHaveBeenCalledWith("deepseek/deepseek-pro");
  });

  it("shows why a switch did not take", async () => {
    route((_url, init) => {
      if (init?.method === "POST") return json({ code: "provider.key_missing" }, 409);
      return json(catalog);
    });
    const onSwitched = vi.fn();
    await render({ onSwitched });

    await act(async () => {
      rows()
        .find((row) => row.textContent?.includes("deepseek-pro"))
        ?.click();
    });
    await settle();

    expect(container.textContent).toContain("还没有配置 API key");
    expect(onSwitched).not.toHaveBeenCalled();
  });

  it("shows a failed read instead of an empty list", async () => {
    route(() => json({ code: "client.offline" }, 500));
    await render();
    expect(container.textContent).toContain("连不上电脑");
    expect(rows()).toHaveLength(0);
  });

  it("carries an unknown refusal code rather than pretending success", async () => {
    route(() => json({ code: "model.some_new_refusal" }, 409));
    await render();
    expect(container.textContent).toContain("model.some_new_refusal");
    expect(rows()).toHaveLength(0);
  });

  it("says so when the machine has nothing to switch to", async () => {
    route(() => json({ current: "", label: "", default: "", models: [] }));
    await render();
    expect(container.textContent).toContain("没有可切换的模型");
  });

  it("says the switch is for this conversation only", async () => {
    route(() => json(catalog));
    await render();
    expect(container.textContent).toContain("只换这一个会话");
  });

  it("offers the model's efforts, auto first, and posts the choice", async () => {
    const fetchMock = route((url, init) => {
      if (url.endsWith("/effort") && init?.method === "POST") {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/status")) {
        return json({ running: false, busy: false, plan: false, effort: "high" });
      }
      return json(catalog);
    });
    await render();

    const group = container.querySelector('[aria-label="思考强度"]');
    expect(group).toBeTruthy();
    const labels = Array.from(group?.querySelectorAll("button") ?? []).map((b) => b.textContent);
    expect(labels).toEqual(["auto", "low", "high"]);

    // The status read said this conversation is on high, so that is the one
    // marked, not the model's declared default.
    const high = Array.from(group?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "high",
    );
    expect(high?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      (Array.from(group?.querySelectorAll("button") ?? []).find(
        (b) => b.textContent === "low",
      ) as HTMLButtonElement).click();
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/effort",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ effort: "low" }) }),
    );
  });

  it("marks auto when the conversation has no effort set", async () => {
    route((url) => {
      if (url.endsWith("/status")) {
        return json({ running: false, busy: false, plan: false });
      }
      return json(catalog);
    });
    await render();

    const auto = Array.from(
      container.querySelectorAll('[aria-label="思考强度"] button'),
    ).find((b) => b.textContent === "auto");
    expect(auto?.getAttribute("aria-pressed")).toBe("true");
  });

  it("hides the effort control for a model that declares none", async () => {
    route((url) => {
      if (url.endsWith("/status")) return json({ running: false, busy: false, plan: false });
      return json({
        current: "plain/model",
        label: "",
        default: "",
        models: [{ ref: "plain/model", provider: "plain", model: "model", active: true }],
      });
    });
    await render();

    expect(container.querySelector('[aria-label="思考强度"]')).toBeNull();
  });

  it("shows why an effort change was refused", async () => {
    route((url, init) => {
      if (url.endsWith("/effort") && init?.method === "POST") {
        return json({ code: "model.effort_unsupported" }, 400);
      }
      if (url.endsWith("/status")) return json({ running: false, busy: false, plan: false });
      return json(catalog);
    });
    await render();

    await act(async () => {
      (Array.from(container.querySelectorAll('[aria-label="思考强度"] button')).find(
        (b) => b.textContent === "low",
      ) as HTMLButtonElement).click();
    });
    await settle();

    expect(container.textContent).toContain("model.effort_unsupported");
  });
});
