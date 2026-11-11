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
  sessionUsage: { requests: 6, cacheHit: 7900, cacheMiss: 2100, cacheUnknown: 0 },
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

function queryOf(input: RequestInfo | URL): URLSearchParams {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  return new URL(raw, window.location.origin).searchParams;
}

// ---- workbench fixtures ----
// Two repositories, a change set with renames, a binary and a mixed-staged
// path, per-path diffs, and a small read-only file system: every workbench
// route answers from the query it was asked, so the flows a reviewer drives
// (repo switch, jump-to-file, search, history drill-down) behave like the
// kernel's instead of returning one canned answer for every path.

const wbRepos = [
  { dir: "", name: "演示项目", branch: "main", detached: false },
  { dir: "packages/app", name: "app", branch: "feat/workbench", detached: false },
];

const wbChanges: Record<string, unknown[]> = {
  "": [
    { path: "src/app/main.tsx", status: "M", staged: true, insertions: 18, deletions: 4 },
    { path: "src/app/main.tsx", status: "M", unstaged: true, insertions: 2 },
    { path: "src/chat/ChatScreen.tsx", status: "M", staged: true, insertions: 64, deletions: 12 },
    { path: "src/chat/workbench/Workbench.tsx", status: "M", unstaged: true, insertions: 141, deletions: 37 },
    { path: "src/chat/workbench/ChangesTree.tsx", status: "M", unstaged: true, insertions: 52, deletions: 8 },
    { path: "src/net/changes.ts", status: "A", staged: true, insertions: 146 },
    { path: "src/net/token.ts", status: "M", staged: true, insertions: 9, deletions: 2 },
    { path: "src/ui/workbench.css", status: "M", unstaged: true, insertions: 210, deletions: 40 },
    { path: "docs/GUIDE.md", status: "R", staged: true, oldPath: "docs/OLD_GUIDE.md" },
    { path: "assets/logo.psd", status: "??" },
    { path: "legacy/unused.go", status: "D", unstaged: true, deletions: 87 },
  ],
  "packages/app": [
    { path: "src/index.ts", status: "M", staged: true, insertions: 12, deletions: 3 },
    { path: "package.json", status: "M", unstaged: true, insertions: 1, deletions: 1 },
  ],
};

const wbGit: Record<string, unknown> = {
  "": { repo: true, name: "演示项目", branch: "main", detached: false, added: 3, removed: 1, untracked: 1 },
  "packages/app": { repo: true, name: "app", branch: "feat/workbench", detached: false, added: 1, removed: 0, untracked: 0 },
};

const wbDiffs: Record<string, string> = {
  "src/app/main.tsx": [
    "@@ -12,7 +12,9 @@ import { boot } from './boot';",
    " import { createRoot } from 'react-dom/client';",
    "-const version = 1;",
    "+const version = 2;",
    "+const flag = true;",
    " export { version };",
    "@@ -40,6 +42,10 @@ function mount() {",
    "   const root = createRoot(document.getElementById('root'));",
    "-  root.render(<App />);",
    "+  root.render(<App flag={flag} />);",
    "+  // A long line so the horizontal scroll and its pinned gutter are exercised: const configuration = loadConfiguration(window.location.search);",
    " }",
  ].join("\n"),
  "src/chat/workbench/Workbench.tsx": [
    "@@ -87,9 +87,14 @@ export function Workbench({",
    "   const { revision, refresh } = useRevision(snapshot, wrote);",
    '   const [tab, setTab] = useState<"changes" | "files">("changes");',
    "+  const [repos, setRepos] = useState<GitReposView['repos'] | null>(null);",
    "+  const [activeRepo, setActiveRepo] = useState(\"\");",
    "   return (",
    '     <div className="wb">',
    "-      <ChangesTree nodes={tree} />",
    "+      <ChangesTree nodes={tree} busy={busy} readOnly={readOnly} />",
    "     </div>",
    "   );",
    " }",
  ].join("\n"),
  "src/net/changes.ts": [
    "@@ -0,0 +1,8 @@",
    "+export type ChangesReply<T> =",
    "+  | { ok: true; value: T }",
    "+  | { ok: false; code: string };",
    "+",
    "+export function loadChanges(base: string, repo?: string) {",
    "+  return get(withQuery(base, '/changes', repoQuery(repo)), parseWorkspaceChanges);",
    "+}",
  ].join("\n"),
  "packages/app/src/index.ts": [
    "@@ -3,5 +3,6 @@ import { serve } from './serve';",
    " const port = Number(process.env.PORT ?? 8788);",
    "-serve({ port });",
    "+serve({ port, host: '0.0.0.0' });",
    "+console.log(`listening on ${port}`);",
  ].join("\n"),
};

function wbDiffFor(path: string): { path: string; diff: string; truncated: boolean } {
  const known = wbDiffs[path];
  if (known) return { path, diff: known, truncated: path === "src/chat/workbench/Workbench.tsx" };
  return {
    path,
    diff: `@@ -1,3 +1,3 @@\n context line\n-const before = "${path}";\n+const after = "${path}";\n`,
    truncated: false,
  };
}

const wbCommits = [
  { id: "9f2c1ab4d5e6", parents: ["4a8d20c9e1f3"], author: "f1shsmell", at: Math.floor(now / 1000) - 3600, refs: ["refs/heads/main"], subject: "移植工作台的第一步" },
  { id: "4a8d20c9e1f3", parents: ["c31b7f02ab88"], author: "f1shsmell", at: Math.floor(now / 1000) - 18_000, refs: [], subject: "fix(chat): 流式间隙不再重复渲染" },
  { id: "c31b7f02ab88", parents: ["77e0d4c1f9a2"], author: "f1shsmell", at: Math.floor(now / 1000) - 86_400, refs: ["refs/tags/v0.5.0"], subject: "feat(net): 工作区文件只读浏览" },
  { id: "77e0d4c1f9a2", parents: ["b19c3e5d7f01"], author: "f1shsmell", at: Math.floor(now / 1000) - 172_800, refs: [], subject: "重构：把 diff 解析抽成纯函数" },
  { id: "b19c3e5d7f01", parents: [], author: "f1shsmell", at: Math.floor(now / 1000) - 518_400, refs: [], subject: "初始提交" },
];

const wbCommitFiles: Record<string, { path: string; status: string; insertions?: number; deletions?: number }[]> = {
  "9f2c1ab4d5e6": [
    { path: "src/chat/workbench/Workbench.tsx", status: "A", insertions: 439 },
    { path: "src/chat/workbench/gittree.ts", status: "A", insertions: 104 },
    { path: "src/ui/workbench.css", status: "A", insertions: 628 },
  ],
  "4a8d20c9e1f3": [
    { path: "src/chat/Rows.tsx", status: "M", insertions: 12, deletions: 4 },
    { path: "src/chat/stream-gap.test.ts", status: "M", insertions: 31, deletions: 2 },
  ],
};

const wbFileContents: Record<string, string> = {
  "README.md": "# 演示项目\n\nmock 内核的只读文件。\n\n## 运行\n\n```bash\nnpm run dev:mock\n```\n",
  "package.json": '{\n  "name": "reasonix-mobile",\n  "version": "0.5.1",\n  "type": "module"\n}\n',
  "src/app/main.tsx": "import { createRoot } from 'react-dom/client';\nimport { App } from './App';\n\nconst version = 2;\nconst flag = true;\n\nconst root = createRoot(document.getElementById('root'));\nroot.render(<App flag={flag} />);\n\nexport { version };\n",
  "src/chat/ChatScreen.tsx": "import { lazy } from 'react';\n\nconst Workbench = lazy(() =>\n  import('./workbench/Workbench').then((m) => ({ default: m.Workbench })),\n);\n\nexport function ChatScreen() {\n  return <div className=\"chat\">…</div>;\n}\n",
  "src/chat/workbench/Workbench.tsx": "import { useRevision } from './useRevision';\n\nexport function Workbench({ base, readOnly, snapshot, wrote, onClose }) {\n  const { revision, refresh } = useRevision(snapshot, wrote);\n  return <div className=\"wb\">…</div>;\n}\n",
  "src/chat/workbench/ChangesTree.tsx": "import { stagedState } from './gittree';\n\nexport function ChangesTree(props) {\n  return <div className=\"wb-tree\">…</div>;\n}\n",
  "src/net/changes.ts": "export type ChangesReply<T> =\n  | { ok: true; value: T }\n  | { ok: false; code: string };\n\nexport function loadChanges(base: string, repo?: string) {\n  return get(withQuery(base, '/changes', repoQuery(repo)), parseWorkspaceChanges);\n}\n",
  "src/net/token.ts": "export function loadToken(): string {\n  return localStorage.getItem('reasonix.token') ?? '';\n}\n",
  "src/ui/workbench.css": ".wb {\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n}\n\n.wb-row {\n  min-height: 44px;\n}\n",
  "docs/GUIDE.md": "# 工作台指南\n\n变更、diff 与提交都在这一屏。\n",
  "packages/app/src/index.ts": "import { serve } from './serve';\n\nconst port = Number(process.env.PORT ?? 8788);\nserve({ port, host: '0.0.0.0' });\nconsole.log(`listening on ${port}`);\n",
  "packages/app/package.json": '{\n  "name": "@demo/app",\n  "version": "0.1.0"\n}\n',
};

/** One folder's listing, or the paths a search matched, from the flat file map. */
function wbListing(path: string, q: string): { files: string[]; directories: string[] } {
  const keys = Object.keys(wbFileContents);
  if (q) {
    const needle = q.toLowerCase();
    const files = keys.filter((key) => key.toLowerCase().includes(needle));
    const dirs = new Set<string>();
    for (const key of keys) {
      const parts = key.split("/");
      for (let i = 1; i < parts.length; i += 1) {
        const dir = parts.slice(0, i).join("/");
        if (dir.toLowerCase().includes(needle)) dirs.add(dir);
      }
    }
    return { files, directories: [...dirs].sort() };
  }
  const prefix = path ? `${path}/` : "";
  const files: string[] = [];
  const dirs = new Set<string>();
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) files.push(rest);
    else dirs.add(prefix + rest.slice(0, slash));
  }
  return { files: files.sort(), directories: [...dirs].sort() };
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
  // The workbench: every route answers from its query, so repo switches,
  // per-path diffs, search and the history drill-down behave like the kernel.
  const query = queryOf(input);
  const wbRepo = query.get("repo") ?? "";
  if (path === BASE + "/git/repos") {
    return Promise.resolve(json({ repos: wbRepos, truncated: false }));
  }
  if (path === BASE + "/changes") {
    return Promise.resolve(json({ repo: true, changes: wbChanges[wbRepo] ?? [] }));
  }
  if (path === BASE + "/changes/diff") {
    return Promise.resolve(json(wbDiffFor(query.get("path") ?? "")));
  }
  if (path === BASE + "/workspace/git") {
    return Promise.resolve(json(wbGit[wbRepo] ?? wbGit[""]));
  }
  if (path === BASE + "/workspace/git/log") {
    return Promise.resolve(json({ repo: true, commits: wbCommits, truncated: false }));
  }
  if (path === BASE + "/git/commit") {
    const id = query.get("id") ?? "";
    const files = wbCommitFiles[id] ?? [{ path: "src/app/main.tsx", status: "M", insertions: 6, deletions: 2 }];
    return Promise.resolve(json({ repo: true, files, truncated: false }));
  }
  if (path === BASE + "/git/commit/diff") {
    return Promise.resolve(json(wbDiffFor(query.get("path") ?? "")));
  }
  if (path === BASE + "/workspace/files") {
    // A real kernel answer takes a network round trip; zero latency here would
    // hide order-of-arrival races the phone actually hits.
    return new Promise((done) => setTimeout(() => done(json(wbListing(query.get("path") ?? "", query.get("q") ?? ""))), 40));
  }
  if (path === BASE + "/workspace/file") {
    const filePath = query.get("path") ?? "";
    return new Promise((done) => setTimeout(() => {
      if (filePath.endsWith(".psd")) {
        done(json({ code: "workspace.file_unreadable" }, 422));
        return;
      }
      const content = wbFileContents[filePath];
      if (content === undefined) {
        done(json({ code: "workspace.file_missing" }, 404));
        return;
      }
      done(json({ path: filePath, content, revision: "mock" }));
    }, 40));
  }
  if (path === BASE + "/commit/propose" && method === "POST") {
    const staged = (wbChanges[wbRepo] ?? []) as { path: string; status: string; staged?: boolean; insertions?: number; deletions?: number }[];
    const seen = new Set<string>();
    const files: Record<string, unknown>[] = [];
    for (const entry of staged) {
      if (entry.staged !== true || seen.has(entry.path)) continue;
      seen.add(entry.path);
      files.push({
        path: entry.path,
        status: entry.status,
        ...(entry.insertions !== undefined ? { insertions: entry.insertions } : {}),
        ...(entry.deletions !== undefined ? { deletions: entry.deletions } : {}),
        ...(entry.path === "src/net/token.ts" ? { sensitive: true } : {}),
      });
    }
    return Promise.resolve(json({
      message: "feat(workbench): 变更树、diff 与提交流程",
      fingerprint: "mock-fingerprint",
      files,
      truncated: false,
      contentSecrets: false,
    }));
  }
  if (path === BASE + "/commit" && method === "POST") {
    let subject = "feat(workbench): 变更树、diff 与提交流程";
    try {
      const body = JSON.parse(String(init.body ?? "{}")) as { message?: unknown };
      if (typeof body.message === "string" && body.message.trim()) {
        subject = body.message.trim().split("\n")[0] ?? subject;
      }
    } catch {
      // A body the mock cannot read still records a commit.
    }
    return Promise.resolve(json({ hash: "b7e3f00d9c1a", subject }));
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
