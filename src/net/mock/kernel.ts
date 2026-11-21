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
/** `?rich=1` swaps the demo transcript for one with code, a table and a
    formula, and makes a submitted turn carry tool steps — the inputs the
    精简/详尽 fold and the markdown paths need to be judged. */
const rich = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("rich") === "1";

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

/**
 * Panes POST /runtimes created. The kernel hands back a fresh pane per call
 * with its own empty transcript; the mock used to answer with one canned
 * pane, which made every "new session" silently reopen the demo one — the
 * review's "新会话显示旧内容" turned out to be exactly this fixture defect.
 */
const created: {
  view: { id: string; base: string; root: string; name: string; sessionPath: string };
  running: boolean;
}[] = [];
let createdSeq = 0;

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

/** The waiting pane's transcript: the plan that is blocked on a decision. */
const apiMessages = [
  { role: "user", content: "帮我把图片压缩服务的重试逻辑改成指数退避，先给个计划再动手。", msgIndex: 0 },
  {
    role: "assistant",
    content: "计划如下：\n1. 重试间隔改为 2s/4s/8s，上限三次；\n2. 失败请求进入死信队列并记录原因；\n3. 配置项 retry.backoff 开关默认关闭。\n确认后我开始改 retries.py 和它的测试。",
    msgIndex: 1,
    modelRef: "demo/demo-flash",
  },
];

/** The working pane's transcript: a long answer still streaming is implied by
    the status; the record itself is a normal finished turn. */
const notesMessages = [
  { role: "user", content: "把《 Honey 用法调研》的要点整理成三条。", msgIndex: 0 },
  {
    role: "assistant",
    content: "1. 并发上限用信号量而不是全局锁；\n2. 缓存键要带参数哈希，否则命中率虚高；\n3. 失败重试放调用方，库内只抛错。",
    msgIndex: 1,
    modelRef: "demo/demo-flash",
  },
];

/** `?rich=1` demo transcript: markdown paths the 精简/详尽 review needs —
    a fenced code block, a table, an inline formula and a quote. */
const richMessages = [
  { role: "user", content: "把重试逻辑改成指数退避，写清楚参数表和公式，再给个对比表格。", msgIndex: 0 },
  {
    role: "assistant",
    content: [
      "改成指数退避：",
      "",
      "```python",
      "RETRY_DELAYS_MS = [2000, 4000, 8000]",
      "",
      "def retry(attempt: int) -> float:",
      "    return RETRY_DELAYS_MS[min(attempt, 2)] / 1000",
      "```",
      "",
      "间隔公式：`delay(n) = base × 2^n`，即 `delay(n) = 2 · 2^n` 秒。",
      "",
      "| 尝试 | 间隔 | 累计 |",
      "| --- | --- | --- |",
      "| 1 | 2s | 2s |",
      "| 2 | 4s | 6s |",
      "| 3 | 8s | 14s |",
      "",
      "> 三次之后进死信队列，不再重试。",
      "",
      "对照旧的固定 5 秒间隔：指数方案前两轮更快、第三轮更慢，总等待 14s 对 15s 基本持平。",
    ].join("\n"),
    msgIndex: 1,
    modelRef: "demo/demo-flash",
  },
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

  constructor(url: string) {
    subscribers.add(this);
    setTimeout(() => {
      if (this.closed) return;
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      const pane = /^\/rt\/([^/]+)\/events$/.exec(new URL(url, window.location.origin).pathname);
      if (pane?.[1] === "api") {
        // The waiting pane's decision reaches the phone as an ask card, the
        // same shape the kernel sends plan approvals in.
        setTimeout(() => {
          this.emit({
            kind: "ask_request",
            ask: {
              id: "plan-api",
              questions: [
                {
                  id: "plan",
                  header: "批准这个计划",
                  prompt: "重试逻辑改成指数退避，动 retries.py 和它的测试。",
                  options: [
                    { label: "按计划开始", description: "先改实现，再补测试" },
                    { label: "只改实现", description: "测试以后再说" },
                    { label: "再调整计划", description: "先不改代码" },
                  ],
                },
              ],
            },
          });
        }, 600);
      }
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

function emitTurn(input: string, onDone?: () => void, tools = false): void {
  const toolSteps: Record<string, unknown>[] = tools
    ? [
        { kind: "tool_dispatch", tool: { id: "t1", name: "edit_file", input: "retries.py · 指数退避" } },
        { kind: "tool_result", tool: { id: "t1", name: "edit_file", output: "2 处修改" } },
        { kind: "tool_dispatch", tool: { id: "t2", name: "run_tests", input: "npm test -- retries" } },
        { kind: "tool_progress", tool: { id: "t2", name: "run_tests", note: "14 passed" } },
        { kind: "tool_result", tool: { id: "t2", name: "run_tests", output: "14 passed, 0 failed" } },
      ]
    : [];
  const events: Record<string, unknown>[] = [
    { kind: "turn_started" },
    { kind: "reasoning", reasoning: "先确认一下需求：两天、轻松、杭州。\n第一天围绕西湖走，但不要把行程排满——用户说了轻松一点。\n上午苏堤或白堤选一条，步行加拍照大约两小时。\n中午在湖滨一带吃饭，顺便避开正午的太阳。\n下午原本想安排游船，但要看天气：下雨就换室内。\n第二天灵隐寺早上去，人少；龙井村下午散步喝茶。\n交通以地铁加步行为主，打车作为雨天的备选。\n还要留一个室内备选：浙江省博物馆之江馆或武林馆。\n住宿建议西湖东侧，地铁方便，晚上也热闹。\n最后把节奏写松一点，每天只排两个主点。" },
    ...toolSteps,
    { kind: "text", text: `收到：“${input.slice(0, 80)}”。这是本地 fixture 的一条回答。` },
    { kind: "message" },
    { kind: "usage", usage: { promptTokens: 42, completionTokens: 18, totalTokens: 60 } },
    { kind: "turn_done" },
  ];
  events.forEach((event, index) => {
    setTimeout(() => {
      for (const source of [...subscribers]) source.emit(event);
      if (event.kind === "turn_done") onDone?.();
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
    if (method === "POST") {
      let body: { root?: unknown; sessionPath?: unknown } = {};
      try {
        body = JSON.parse(String(init.body ?? "{}")) as typeof body;
      } catch {
        // An unreadable body still opens a pane in the demo project.
      }
      const root = typeof body.root === "string" && body.root ? body.root : "/demo";
      // Opening a stored session rebinds its file: the canned panes own the
      // three transcript files the tree ships with.
      const requested = typeof body.sessionPath === "string" ? body.sessionPath : "";
      const known =
        requested === "/demo/.reasonix/api.jsonl"
          ? reviewRuntime
          : requested === "/demo/.reasonix/notes.jsonl"
            ? notesRuntime
            : requested === "/demo/.reasonix/demo.jsonl"
              ? runtime
              : null;
      if (known) return Promise.resolve(json(known));
      createdSeq += 1;
      const id = `s${createdSeq}`;
      const view = {
        id,
        base: `/rt/${id}`,
        root,
        name: root.split("/").filter(Boolean).pop() || "新会话",
        sessionPath:
          typeof body.sessionPath === "string" ? body.sessionPath : `${root}/.reasonix/${id}.jsonl`,
      };
      created.push({ view, running: false });
      // The recent list reads the tree, and a created pane owns a session
      // file the tree should know about.
      tree[0]?.sessions.push({
        path: view.sessionPath,
        name: id,
        title: "新会话",
        turns: 0,
        lastActiveAt: Date.now(),
      });
      return Promise.resolve(json(view));
    }
    // Every canned pane is open: a session=api dev link has to find its
    // runtime in the list, and the review's unverified states all live on
    // these panes.
    return Promise.resolve(json([
      runtime,
      reviewRuntime,
      notesRuntime,
      ...created.map((entry) => entry.view),
    ]));
  }
  if (path === "/tree") return Promise.resolve(json(tourTree));
  if (path === BASE + "/status") return Promise.resolve(json(status));
  if (path === "/rt/api/status") return Promise.resolve(json(reviewStatus));
  if (path === "/rt/notes/status") return Promise.resolve(json(notesStatus));
  const demoHistory = rich ? richMessages : messages;
  if (path === BASE + "/history/page") {
    return Promise.resolve(json({
      messages: demoHistory,
      total: demoHistory.length,
      hasMoreBefore: false,
      start: 0,
      end: demoHistory.length,
      snapshot: "mock-1",
    }));
  }
  if (path === BASE + "/history") return Promise.resolve(json(demoHistory));
  if (path === BASE + "/todos") return Promise.resolve(json([]));
  if (path === BASE + "/models") return Promise.resolve(json(models));
  // The waiting pane's transcript, so its plan approval renders as a card
  // instead of an error: this is the normal state the review never saw.
  if (path === "/rt/api/history") return Promise.resolve(json(apiMessages));
  if (path === "/rt/api/history/page") {
    return Promise.resolve(json({
      messages: apiMessages,
      total: apiMessages.length,
      hasMoreBefore: false,
      start: 0,
      end: apiMessages.length,
      snapshot: "mock-api",
    }));
  }
  if (path === "/rt/notes/history") return Promise.resolve(json(notesMessages));
  if (path === "/rt/notes/history/page") {
    return Promise.resolve(json({
      messages: notesMessages,
      total: notesMessages.length,
      hasMoreBefore: false,
      start: 0,
      end: notesMessages.length,
      snapshot: "mock-notes",
    }));
  }

  // The sheets' normal states: queue, checkpoints and context for the canned
  // panes, so the review's "只见错误/加载态" has a rendered counterexample.
  const cannedSheet = /^\/rt\/(demo|api|notes)\/(inbox|checkpoints|context)$/.exec(path);
  if (cannedSheet) {
    if (cannedSheet[2] === "inbox") {
      return Promise.resolve(json({
        revision: 3,
        paused: false,
        unrecovered: false,
        items: [
          {
            id: "q1",
            intent: "followup",
            state: "queued",
            preview: "第二天要是下雨就把整个行程挪到室内，博物馆优先。",
            createdAt: new Date(now - 4 * 60_000).toISOString(),
            byteSize: 64,
          },
          {
            id: "q2",
            intent: "steer",
            state: "steer_accepted",
            preview: "顺便把酒店也订了。",
            createdAt: new Date(now - 2 * 60_000).toISOString(),
            byteSize: 28,
          },
        ],
      }));
    }
    if (cannedSheet[2] === "checkpoints") {
      return Promise.resolve(json([
        { turn: 1, prompt: "帮我整理一个周末去杭州的两天行程，轻松一点。", files: 0, msgIndex: 0 },
        { turn: 3, prompt: "把第一天下午改成室内，万一下雨。", files: 2, msgIndex: 2 },
      ]));
    }
    return Promise.resolve(json({
      used: 42000,
      window: 128000,
      system: 3100,
      tools: 8400,
      user: 5200,
      reply: 23100,
      output: 2200,
      compactAt: 96000,
      boundary: "economic",
      capacityAt: 128000,
      largest: [
        { class: "reply", tool: "", tokens: 9800 },
        { class: "tools", tool: "read_file", tokens: 6100 },
        { class: "user", tool: "", tokens: 3100 },
      ],
    }));
  }

  // A pane POST /runtimes created: its transcript is empty, its status is a
  // plain idle one, and a submit actually runs there — the dispatch flow and
  // the new-session flow both land here.
  const createdPane = /^\/rt\/(s\d+)\/(status|history|history\/page|todos)$/.exec(path);
  if (createdPane) {
    const id = createdPane[1];
    const entry = created.find((candidate) => candidate.view.id === id);
    if (entry === undefined) return Promise.resolve(json({ code: "mock.unknown" }, 404));
    if (createdPane[2] === "status") {
      return Promise.resolve(json({
        ...status,
        running: entry.running,
        busy: entry.running,
        sessionPath: entry.view.sessionPath,
      }));
    }
    if (createdPane[2] === "todos") return Promise.resolve(json([]));
    if (createdPane[2] === "history") return Promise.resolve(json([]));
    return Promise.resolve(json({
      messages: [],
      total: 0,
      hasMoreBefore: false,
      start: 0,
      end: 0,
      snapshot: `mock-${id}`,
    }));
  }

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
  if (/^\/rt\/(s\d+)\/submit$/.test(path) && method === "POST") {
    const paneId = /^\/rt\/(s\d+)\/submit$/.exec(path)?.[1] ?? "";
    const entry = created.find((candidate) => candidate.view.id === paneId);
    if (entry === undefined) return Promise.resolve(json({ code: "mock.unknown" }, 404));
    let body = "";
    if (typeof init.body === "string") body = init.body;
    let prompt = "";
    try {
      prompt = String((JSON.parse(body) as { input?: unknown }).input ?? "");
    } catch {
      // An empty fixture prompt is still a valid turn.
    }
    entry.running = true;
    emitTurn(prompt, () => {
      entry.running = false;
    }, rich);
    return Promise.resolve(noContent());
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
    emitTurn(prompt, undefined, rich);
    return Promise.resolve(noContent());
  }
  if (method === "POST") return Promise.resolve(noContent());
  return Promise.resolve(json({ code: "mock.unknown" }, 404));
}

const transport: KernelTransport = {
  fetch: mockFetch,
  eventSource: (streamUrl) => new MockEventSource(streamUrl),
};

let installed = false;

export function installMockKernel(): void {
  if (installed) return;
  installed = true;
  setKernelTransport(transport);
}
