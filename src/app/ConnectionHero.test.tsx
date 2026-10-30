import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionHero } from "./ConnectionHero";
import { idleLink } from "../net/link";
import type { LinkState } from "../net/link";

let container: HTMLDivElement;
let root: Root | null = null;

function render(props: Parameters<typeof ConnectionHero>[0]): HTMLElement {
  act(() => root?.unmount());
  root = createRoot(container);
  act(() => {
    root?.render(<ConnectionHero {...props} />);
  });
  return container;
}

function link(overrides: Partial<LinkState>): LinkState {
  return { ...idleLink, ...overrides };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe("ConnectionHero", () => {
  it("draws the three-stroke mark and the idle detail", () => {
    const hero = render({ name: "192.168.5.2:56789", detail: "局域网直连", link: idleLink });

    expect(hero.querySelectorAll(".rmark path")).toHaveLength(3);
    expect(hero.querySelector(".link-hero-title")?.textContent).toBe("192.168.5.2:56789");
    expect(hero.querySelector(".link-hero-sub")?.textContent).toBe("局域网直连");
    expect(hero.querySelector(".link-hero")?.getAttribute("data-live")).toBeNull();
    expect(hero.querySelector(".link-hero")?.getAttribute("data-tone")).toBe("idle");
    expect(hero.querySelector(".link-hero")?.getAttribute("data-compact")).toBe("true");
    expect(hero.querySelector(".link-steps")).toBeNull();
  });

  it("traces while connecting and names the stage", () => {
    const hero = render({
      name: "工作站",
      detail: "",
      link: link({ phase: "connecting", step: "switch", completed: ["probe"] }),
    });

    const section = hero.querySelector(".link-hero");
    expect(section?.getAttribute("data-live")).toBe("true");
    expect(section?.getAttribute("data-tone")).toBe("busy");
    expect(section?.getAttribute("data-compact")).toBeNull();
    expect(hero.querySelector(".link-hero-sub")?.textContent).toBe("正在切换连接…");

    const steps = Array.from(hero.querySelectorAll(".link-steps li"));
    expect(steps.map((step) => step.textContent)).toEqual([
      "正在查找电脑",
      "正在切换连接",
      "正在读取会话",
    ]);
    expect(steps.map((step) => step.getAttribute("data-state"))).toEqual([
      "done",
      "active",
      "pending",
    ]);
  });

  it("keeps tracing during a reconnecting attempt and says which one", () => {
    const hero = render({
      name: "工作站",
      detail: "",
      link: link({ phase: "reconnecting", attempt: 2, nextRetryAt: Date.now() + 5_000 }),
    });

    expect(hero.querySelector(".link-hero")?.getAttribute("data-tone")).toBe("warn");
    expect(hero.querySelector(".link-hero")?.getAttribute("data-live")).toBe("true");
    expect(hero.querySelector(".link-hero-sub")?.textContent).toBe("正在重连（第 2 次）");
  });

  it("rests on the failure sentence instead of animating", () => {
    const hero = render({
      name: "工作站",
      detail: "",
      link: link({
        phase: "failed",
        error: { code: "client.offline", message: "到不了这台电脑。", retryable: true },
      }),
    });

    expect(hero.querySelector(".link-hero")?.getAttribute("data-tone")).toBe("bad");
    expect(hero.querySelector(".link-hero")?.getAttribute("data-live")).toBeNull();
    expect(hero.querySelector(".link-hero-sub")?.textContent).toBe("到不了这台电脑。");
  });

  it("shows a live manual attempt in the link machine's words", () => {
    const hero = render({
      name: "工作站",
      detail: "",
      link: link({ phase: "connecting", step: "switch" }),
      busy: "正在连接云端",
    });

    expect(hero.querySelector(".link-hero-sub")?.textContent).toBe("正在连接云端…");
    expect(hero.querySelector(".link-hero")?.getAttribute("data-live")).toBe("true");
    // A manual attempt is one action, not the machine's three stages.
    expect(hero.querySelector(".link-steps")).toBeNull();
  });

  it("falls back to the detail when the machine has not started", () => {
    const hero = render({ name: "连接你的电脑", detail: "扫码、粘贴链接，或登录账号" });
    expect(hero.querySelector(".link-hero-sub")?.textContent).toBe("扫码、粘贴链接，或登录账号");
  });
});
