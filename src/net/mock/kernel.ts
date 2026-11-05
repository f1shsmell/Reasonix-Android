/**
 * A scripted kernel for the browser dev build.
 *
 * It implements the same HTTP/SSE contract the endpoint modules already speak,
 * so no screen or net module knows the kernel is absent. Imported only by the
 * dev entry point; production builds never load this file.
 */

import type { KernelEventSource, KernelTransport } from "../transport";
import { setKernelTransport } from "../transport";

const ORIGIN = "http://mock.local";
const BASE = "/rt/demo";
const now = Date.now();

const runtime = {
  id: "demo",
  base: BASE,
  root: "/demo",
  name: "演示项目",
  sessionPath: "/demo/.reasonix/demo.jsonl",
};

const tree = [{
  root: "/demo",
  name: "演示项目",
  open: true,
  remembered: true,
  total: 3,
  remaining: 0,
  sessions: [
    { path: "/demo/.reasonix/demo.jsonl", name: "demo", title: "周末出行计划", turns: 4, lastActiveAt: now - 3_600_000 },
    { path: "/demo/.reasonix/api.jsonl", name: "api", title: "接口设计草稿", turns: 2, lastActiveAt: now - 7_200_000 },
    { path: "/demo/.reasonix/notes.jsonl", name: "notes", title: "读书笔记", turns: 3, lastActiveAt: now - 93_600_000 },
  ],
}];

const messages = [
  { role: "user", content: "帮我整理一个周末去杭州的两天行程，轻松一点。", msgIndex: 0 },
  { role: "assistant", content: "可以。第一天西湖周边，第二天灵隐寺和龙井村，节奏放慢。", msgIndex: 1, modelRef: "demo/demo-flash" },
  { role: "user", content: "把第一天下午改成室内，万一下雨。", msgIndex: 2 },
  { role: "assistant", content: "那就把下午换成浙江省博物馆，傍晚再去湖边走走。", msgIndex: 3, modelRef: "demo/demo-flash" },
];

const status = {
  running: false,
  busy: false,
  plan: false,
  modelRef: "demo/demo-flash",
  effort: "standard",
  workspaceRoot: "/demo",
  sessionPath: "/demo/.reasonix/demo.jsonl",
  toolApprovalMode: "ask",
  decisions: [],
};

const config = {
  origin: ORIGIN,
  candidates: [],
  preferred: [],
  direct: [],
  paired: true,
  mode: "lan",
  studioUrl: "",
  vpn: false,
  lan: true,
  netPolicy: "auto",
  account: { signedIn: false },
};

const models = {
  current: "demo/demo-flash",
  label: "Demo Flash",
  default: "demo/demo-flash",
  models: [{
    ref: "demo/demo-flash",
    provider: "demo",
    model: "demo-flash",
    displayName: "Demo Flash",
    active: true,
    default: true,
    efforts: ["auto", "low", "high"],
    effort: "standard",
    contextWindow: 128000,
  }],
};

class MockEventSource implements KernelEventSource {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private closed = false;
  private seq = 0;

  constructor() {
    subscribers.add(this);
    setTimeout(() => {
      if (this.closed) return;
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    }, 0);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
    subscribers.delete(this);
  }

  emit(event: Record<string, unknown>): void {
    if (this.closed) return;
    this.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify(event),
      lastEventId: String(++this.seq),
    }));
  }
}

const subscribers = new Set<MockEventSource>();

function json(value: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(value), {
    status: statusCode,
    headers: { "content-type": "application/json" },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function pathOf(input: RequestInfo | URL): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  return new URL(raw, window.location.origin).pathname;
}

function emitTurn(input: string): void {
  const events: Record<string, unknown>[] = [
    { kind: "turn_started" },
    { kind: "reasoning", text: "先确认一下需求，再给出可以直接执行的安排。" },
    { kind: "text", text: `收到：“${input.slice(0, 80)}”。这是本地 fixture 的一条回答。` },
    { kind: "message" },
    { kind: "usage", usage: { promptTokens: 42, completionTokens: 18, totalTokens: 60 } },
    { kind: "turn_done" },
  ];
  events.forEach((event, index) => {
    setTimeout(() => {
      for (const source of [...subscribers]) source.emit(event);
    }, 180 * (index + 1));
  });
}

function mockFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const path = pathOf(input);
  const method = (init.method ?? "GET").toUpperCase();

  if (path === "/__reasonix/config") return Promise.resolve(json(config));
  if (path === "/__reasonix/refresh") return Promise.resolve(json(config));
  if (path === "/__reasonix/fleet") return Promise.resolve(json({ peers: [] }));
  if (path === "/__reasonix/account") return Promise.resolve(json({ signedIn: false }));
  if (path === "/__reasonix/account/devices") return Promise.resolve(json({ devices: [] }));
  if (path.startsWith("/__reasonix/")) return Promise.resolve(json({ code: "mock.unknown" }, 404));

  if (path === "/runtimes") {
    return Promise.resolve(method === "POST" ? json(runtime) : json([runtime]));
  }
  if (path === "/tree") return Promise.resolve(json(tree));
  if (path === BASE + "/status") return Promise.resolve(json(status));
  if (path === BASE + "/history/page") {
    return Promise.resolve(json({
      messages,
      total: messages.length,
      hasMoreBefore: false,
      start: 0,
      end: messages.length,
      snapshot: "mock-1",
    }));
  }
  if (path === BASE + "/history") return Promise.resolve(json(messages));
  if (path === BASE + "/todos") return Promise.resolve(json([]));
  if (path === BASE + "/models") return Promise.resolve(json(models));
  if (path === BASE + "/submit" && method === "POST") {
    let body = "";
    if (typeof init.body === "string") body = init.body;
    let prompt = "";
    try {
      prompt = String((JSON.parse(body) as { input?: unknown }).input ?? "");
    } catch {
      // An empty fixture prompt is still a valid turn.
    }
    emitTurn(prompt);
    return Promise.resolve(noContent());
  }
  if (method === "POST") return Promise.resolve(noContent());
  return Promise.resolve(json({ code: "mock.unknown" }, 404));
}

const transport: KernelTransport = {
  fetch: mockFetch,
  eventSource: () => new MockEventSource(),
};

let installed = false;

export function installMockKernel(): void {
  if (installed) return;
  installed = true;
  setKernelTransport(transport);
  widgetFetch();
  widgetEventSource();
}

function widgetFetch(): void {
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    if (path.startsWith("/__reasonix/") || path === "/runtimes" || path === "/tree"
        || path.startsWith("/rt/")) {
      return mockFetch(input, init);
    }
    return original(input, init);
  };
}

function widgetEventSource(): void {
  window.EventSource = MockEventSource as unknown as typeof EventSource;
}