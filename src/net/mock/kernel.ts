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
/** `?tour=1` scripts the states the README renders: waiting, running, slow. */
const tour = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("tour") === "1";

const runtime = {
  id: "demo",
  base: BASE,
  root: "/demo",
  name: "演示项目",
  sessionPath: "/demo/.reasonix/demo.jsonl",
};

/** A second pane, blocked on a plan decision, for the home "waiting" block. */
const reviewRuntime = {
  id: "api",
  base: "/rt/api",
  root: "/demo",
  name: "接口设计草稿",
};

/** A third pane, still working, for the home "running" block. */
const notesRuntime = {
  id: "notes",
  base: "/rt/notes",
  root: "/demo",
  name: "读书笔记",
  sessionPath: "/demo/.reasonix/notes.jsonl",
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

const tourTree = tour
  ? tree.map((project) => ({
      ...project,
      sessions: project.sessions.map((session) =>
        session.name === "notes" ? { ...session, runtimeId: "notes" } : session,
      ),
    }))
  : tree;

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
  effort: "high",
  workspaceRoot: "/demo",
  sessionPath: "/demo/.reasonix/demo.jsonl",
  toolApprovalMode: "ask",
  decisions: [],
};

/** The waiting pane's status: a plan approval blocks it. */
const reviewStatus = {
  ...status,
  busy: true,
  plan: true,
  sessionPath: "/demo/.reasonix/api.jsonl",
  decisions: [{ id: "plan-1", kind: "plan_approval" }],
};

/** The working pane's status. */
const notesStatus = {
  ...status,
  running: true,
  busy: true,
  sessionPath: "/demo/.reasonix/notes.jsonl",
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
  ephemeral: true,
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
    effort: "high",
    contextWindow: 128000,
  }, {
    ref: "demo/demo-reasoner",
    provider: "demo",
    model: "demo-reasoner",
    displayName: "Demo Reasoner",
    efforts: ["auto", "low", "high", "max"],
    effort: "auto",
    contextWindow: 256000,
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
      if (new URLSearchParams(window.location.search).get("ask") === "1") {
        setTimeout(() => {
          this.emit({
            kind: "ask_request",
            ask: {
              id: "ask-demo",
              questions: [
                {
                  id: "q1",
                  header: "下午安排",
                  prompt: "第一天下午想去哪里？",
                  options: [
                    { label: "浙江省博物馆", description: "室内为主，雨天也不受影响" },
                    { label: "龙井村", description: "茶园散步，路上时间更长" },
                    { label: "西湖边随便走", description: "不赶点，看当天状态" },
                  ],
                },
                {
                  id: "q2",
                  header: "住哪一带",
                  prompt: "住哪一带更方便？",
                  options: [
                    { label: "西湖边", description: "离景点近，晚上热闹" },
                    { label: "龙井村", description: "安静，早上空气好" },
                    { label: "武林广场", description: "交通方便，吃的多" },
                  ],
                },
                {
                  id: "q3",
                  header: "交通方式",
                  prompt: "在杭州怎么出行？",
                  options: [
                    { label: "地铁为主", description: "不堵车，换乘多一点" },
                    { label: "打车为主", description: "省心，雨天更贵" },
                  ],
                },
                {
                  id: "q4",
                  header: "行程名字",
                  prompt: "给这次行程起个名字",
                  options: [
                    { label: "杭州慢行" },
                    { label: "两天西湖" },
                  ],
                },
              ],
            },
          });
        }, 600);
      }
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
    }, (tour ? 900 : 180) * (index + 1));
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

  if (path === "/models") return Promise.resolve(json({ models: models.models }));
  if (path === "/runtimes") {
    if (method === "POST") return Promise.resolve(json(runtime));
    return Promise.resolve(json(tour ? [runtime, reviewRuntime, notesRuntime] : [runtime]));
  }
  if (path === "/tree") return Promise.resolve(json(tourTree));
  if (path === BASE + "/status") return Promise.resolve(json(status));
  if (path === "/rt/api/status") return Promise.resolve(json(reviewStatus));
  if (path === "/rt/notes/status") return Promise.resolve(json(notesStatus));
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
  // The workbench: a two-file change set (one binary, so the counts answer is
  // exercised too), a small diff, and the git identity the header draws.
  if (path === BASE + "/changes") {
    return Promise.resolve(json({
      repo: true,
      changes: [
        { path: "src/app/main.tsx", status: "M", staged: true, insertions: 18, deletions: 4 },
        { path: "src/app/main.tsx", status: "M", unstaged: true, insertions: 2 },
        { path: "src/net/changes.ts", status: "A", staged: true, insertions: 146 },
        { path: "assets/logo.psd", status: "??" },
      ],
    }));
  }
  if (path === BASE + "/changes/diff") {
    return Promise.resolve(json({
      path: "src/app/main.tsx",
      diff: [
        "@@ -12,7 +12,9 @@",
        " import { boot } from './boot';",
        "-const version = 1;",
        "+const version = 2;",
        "+const flag = true;",
        " export { version };",
      ].join("\n"),
      truncated: false,
    }));
  }
  if (path === BASE + "/workspace/git") {
    return Promise.resolve(json({
      repo: true, name: "demo", branch: "main", detached: false,
      added: 2, removed: 0, untracked: 1,
    }));
  }
  if (path === BASE + "/workspace/git/log") {
    return Promise.resolve(json({
      repo: true,
      commits: [
        { id: "9f2c1ab4d5e6", parents: [], author: "demo", at: Math.floor(Date.now() / 1000) - 3600, refs: ["refs/heads/main"], subject: "移植工作台的第一步" },
      ],
      truncated: false,
    }));
  }
  if (path === BASE + "/workspace/files") {
    return Promise.resolve(json({
      files: ["main.tsx", "README.md"],
      directories: ["src"],
    }));
  }
  if (path === BASE + "/workspace/file") {
    return Promise.resolve(json({
      path: "README.md", content: "# 演示\n\nmock 内核的只读文件。\n",
      revision: "mock",
    }));
  }
  if (path === BASE + "/commit/propose" && method === "POST") {
    return Promise.resolve(json({
      message: "移植工作台：变更列表与 diff",
      fingerprint: "mock-fingerprint",
      files: [{ path: "src/app/main.tsx", status: "M", insertions: 20, deletions: 4 }],
      truncated: false,
      contentSecrets: false,
    }));
  }
  if (path === BASE + "/commit" && method === "POST") {
    return Promise.resolve(json({ hash: "b7e3f00d9c1a", subject: "移植工作台：变更列表与 diff" }));
  }
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
}
