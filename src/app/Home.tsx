/**
 * The home screen: what a person opens the app to see.
 *
 * Two views, one search box. "最近" is every conversation across every
 * project, newest first — the question a phone actually asks ("where was I?").
 * "项目" is the folder list, which is how the desktop organises the same work.
 * A conversation row carries its project name, so a flat list stays readable
 * when titles repeat.
 *
 * This is modelled on Alma's phone client: a centred title with the settings
 * and new-session actions, a search field, a two-way segmented control, and
 * rows of title + relative time + chevron. The difference is what a row is
 * here — a stored transcript, not an open pane.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionSnapshot } from "../net/connection";
import type { TreeProject, TreeSession } from "../wire/tree";
import { decisionLabel, decisionVerb } from "../net/status";
import {
  moveSessionTo,
  placeProject,
  removeSession,
  renameSession,
  setArchived,
  setPinned,
  treeWriteMessage,
} from "../net/pin";
import type { TreeWrite } from "../net/pin";
import { linkSummary, linkTone } from "../net/link";
import type { LinkState } from "../net/link";
import { connectionKey, loadConnections, moveConnection } from "../net/savedConnections";
import type { SavedConnection } from "../net/savedConnections";
import { originKey, peerTone } from "../net/fleet";
import type { FleetSnapshot, FleetPendingItem, FleetRunningItem } from "../net/fleet";
import type { HomeTab } from "./homeTab";
import { dropBefore } from "./projectOrder";
import { dragShift, dropEdge, useRowDrag } from "./useRowDrag";
import type { RowDragHandlers } from "./useRowDrag";
import { useLongPress } from "./longPress";
import { useBackCloser } from "./backStack";
import { SessionSheet } from "./SessionSheet";
import { BrandMark } from "./BrandMark";
import { StudioIcon } from "./StudioIcon";
import { ReachBanner } from "./ReachBanner";
import { relativeTime } from "./format";
import { deleteWarning, runtimeOpenMessage, sessionTitle } from "./SessionList";
import type { NeedsYouState } from "./useNeedsYou";
import type { TreeState } from "./useTree";
import { openRuntime } from "../net/workspaces";
import { DispatchPage } from "./DispatchPage";
import type { DispatchOptions, DispatchResult } from "./DispatchPage";
import { loadDispatchAfter } from "./dispatchPref";

type Tab = HomeTab;

export interface HomeProps {
  snapshot: ConnectionSnapshot;
  tree: TreeState;
  /** Conversations whose pane is blocked on the person right now. */
  pending: NeedsYouState;
  /**
   * The view showing. Held above this screen so opening a project and coming
   * back lands on the projects, not on whichever view is the default.
   */
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  /** The state of this phone's link to a computer. */
  link: LinkState;
  /** Switch to a recorded computer; the connection screen owns the write. */
  onSwitchConnection: (entry: SavedConnection) => void;
  /** Retry the current door after a failure or an exhausted backoff. */
  onRetryLink: () => void;
  onOpenProject: (root: string) => void;
  /** A pane was opened (or found) for this conversation. */
  onOpenSession: (runtimeId: string, root: string, title: string) => void;
  /** Open a pane that is already running, without opening a second one. */
  onOpenRuntime: (runtimeId: string, root: string, title: string) => void;
  /** Send a task and leave it running; the app answers whether it started. */
  onDispatch?: (
    root: string,
    prompt: string,
    options?: DispatchOptions,
  ) => Promise<DispatchResult>;
  onRefresh: () => void;
  /** Open the connection/account screen (sign-in, LAN switch, cloud devices). */
  onSettings?: () => void;
  /** What the other watched computers are doing, when the proxy can watch. */
  fleet?: FleetSnapshot;
  /** Open a conversation that lives on another computer: switch, then open. */
  onOpenFleet?: (item: FleetPendingItem | FleetRunningItem) => void;
}

interface RecentRow {
  project: TreeProject;
  session: TreeSession;
}

/** The newest write in a project; the row's own timestamp is not sent. */
export function projectActivity(project: TreeProject): number {
  let newest = 0;
  for (const session of project.sessions) {
    if (session.lastActiveAt !== undefined && session.lastActiveAt > newest) {
      newest = session.lastActiveAt;
    }
  }
  return newest;
}

/**
 * Every conversation the loaded tree carries, newest first, pinned on top.
 *
 * The tree is already sorted inside each project; this is the merge across
 * projects that makes "最近" a global list. It is a read of what `/tree`
 * returned, not a second request.
 *
 * Pinned rows lead, and each group keeps its own recency order: the kernel
 * does not sort pins first, and pinning one row must not reshuffle the rest.
 */
export function recentConversations(projects: TreeProject[]): RecentRow[] {
  const rows: RecentRow[] = [];
  for (const project of projects) {
    for (const session of project.sessions) {
      rows.push({ project, session });
    }
  }
  rows.sort((a, b) => (b.session.lastActiveAt ?? 0) - (a.session.lastActiveAt ?? 0));
  return pinnedFirstRows(rows);
}

/** A stable partition of the merged rows; see `recentConversations`. */
export function pinnedFirstRows(rows: RecentRow[]): RecentRow[] {
  const pinned = rows.filter((row) => row.session.pinned === true);
  if (pinned.length === 0) return rows;
  return [...pinned, ...rows.filter((row) => row.session.pinned !== true)];
}

function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query);
}

function projectMatches(project: TreeProject, query: string): boolean {
  return matches(project.name, query) || matches(project.root, query);
}

function sessionMatches(row: RecentRow, query: string): boolean {
  return (
    matches(sessionTitle(row.session), query) ||
    matches(row.session.name, query) ||
    projectMatches(row.project, query)
  );
}

function summary(project: TreeProject): string {
  const parts: string[] = [];
  parts.push(project.total > 0 ? `${project.total} 个会话` : "还没有会话");
  if (project.missing) parts.push("文件夹不见了");
  return parts.join(" · ");
}

/**
 * The conversations a turn is blocked on, above everything else.
 *
 * This is the one block a phone is opened for: something on the desktop is
 * waiting for an answer and the person is not at the desk. Each card names the
 * conversation, what it wants, and the project, and opening one goes straight
 * to that pane — the prompt is already in its transcript.
 *
 * The block draws nothing when nothing is waiting, so a quiet list is not
 * interrupted by an empty heading.
 */
/** How long a card has waited, in the coarsest useful unit. */
function duration(since: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天`;
}

function waited(since: number): string {
  const age = duration(since);
  return age === "刚刚" ? age : `等待 ${age}`;
}

function runningFor(since: number): string {
  const age = duration(since);
  return age === "刚刚" ? "刚刚开始" : `运行 ${age}`;
}

function decisionAction(kind: string): string {
  switch (kind) {
    case "ask":
      return "去回答";
    case "plan_approval":
    case "tool_approval":
      return "去批准";
    case "recovery_approval":
      return "去恢复";
    default:
      return "去处理";
  }
}

function NeedsYou({
  pending,
  computerName,
  onOpen,
}: {
  pending: NeedsYouState;
  /** What to call the computer in use; other computers are in the fleet bar. */
  computerName?: string | undefined;
  onOpen: (item: { runtimeId: string; projectRoot: string; title: string }) => void;
}) {
  // Oldest first: the thing that has waited longest is the one to look at.
  const waiting = [...pending.items].sort((a, b) => a.firstSeenAt - b.firstSeenAt);
  // A blocked turn is already in the first list; repeating it under "running"
  // would make one conversation look like two.
  const running = pending.running
    .filter((item) => !waiting.some((entry) => entry.runtimeId === item.runtimeId))
    .sort((a, b) => a.firstSeenAt - b.firstSeenAt);
  if (pending.status === "loaded" && waiting.length === 0 && running.length === 0) return null;
  if (pending.status === "loading" && waiting.length === 0 && running.length === 0) return null;

  return (
    <section className="needs-you" aria-label="正在处理">
      {waiting.length > 0 ? (
        <>
          <div className="section-head">
            <h2>待你处理</h2>
            <span className="meta">{waiting.length}</span>
          </div>
          <ul className="cards">
            {waiting.map((item) => (
              <li key={`${item.runtimeId}\u0000${item.decision.id}`}>
                <button
                  type="button"
                  className="card-need"
                  onClick={() => {
                    pending.markSeen(item);
                    onOpen(item);
                  }}
                  aria-label={`${item.title} ${decisionVerb(item.decision)}`}
                >
                  <span className="need-top">
                    <span className="need-verb">{decisionVerb(item.decision)}</span>
                    {item.isNew ? <span className="need-new">新</span> : null}
                  </span>
                  <strong>{item.title}</strong>
                  <span className="need-what">{decisionLabel(item.decision)}</span>
                  <span className="need-meta">
                    <span className="need-where">
                      {[computerName, item.projectName].filter(Boolean).join(" · ")}
                    </span>
                    <span className="need-age">{waited(item.firstSeenAt)}</span>
                  </span>
                  <span className="need-cta">{decisionAction(item.decision.kind)} ›</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {running.length > 0 ? (
        <>
          <div className="section-head">
            <h2>正在运行</h2>
            <span className="meta">{running.length}</span>
          </div>
          <ul className="cards">
            {running.map((item) => (
              <li key={`run:${item.runtimeId}`}>
                <button
                  type="button"
                  className="card-need"
                  data-kind="running"
                  onClick={() => onOpen(item)}
                  aria-label={`${item.title} 正在运行`}
                >
                  <span className="need-top">
                    <span className="need-verb">运行中</span>
                  </span>
                  <strong>{item.title}</strong>
                  <span className="need-what">正在处理…</span>
                  <span className="need-meta">
                    <span className="need-where">
                      {[computerName, item.projectName].filter(Boolean).join(" · ")}
                    </span>
                    <span className="need-age">{runningFor(item.firstSeenAt)}</span>
                  </span>
                  <span className="need-cta">查看 ›</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function Chevron() {
  return (
    <span className="chev" aria-hidden="true">
      ›
    </span>
  );
}

function RecentItem({
  row,
  busy,
  onOpen,
  onMenu,
}: {
  row: RecentRow;
  busy: boolean;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const { project, session } = row;
  const pinned = session.pinned === true;
  const press = useLongPress(onMenu);
  return (
    <li className={pinned ? "pinned" : undefined}>
      <button
        type="button"
        className="session"
        onClick={onOpen}
        disabled={busy}
        aria-haspopup="menu"
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          onMenu();
        }}
        {...press}
      >
        <span className="session-mark" aria-hidden="true" />
        <span className="row-main">
          <span className="session-name">
            {pinned ? (
              <span className="pin-mark" aria-hidden="true">
                📌
              </span>
            ) : null}
            <span className="row-title">{sessionTitle(session)}</span>
            {session.unread ? (
              <span className="dot accent" role="img" aria-label="有新回答" title="有新回答" />
            ) : null}
            {session.runtimeId ? <span className="pill">运行中</span> : null}
          </span>
          <span className="session-meta">
            {busy ? "正在打开…" : [project.name, relativeTime(session.lastActiveAt)].filter(Boolean).join(" · ")}
          </span>
        </span>
        <Chevron />
      </button>
    </li>
  );
}

/**
 * The computer this phone is talking to, and how that is going.
 *
 * It sits under the title bar rather than inside the settings screen: which
 * computer and whether it is reachable decide what every list below means, and
 * a link that has been reconnecting for a minute should not be invisible.
 */
function LinkBar({ link, name: preferred, onOpen }: { link: LinkState; name?: string | undefined; onOpen: () => void }) {
  const name = preferred ?? link.name ?? (link.phase === "connected" ? "电脑" : "没有连接电脑");
  return (
    <button
      type="button"
      className="linkbar"
      onClick={onOpen}
      aria-label={`连接：${name}，${linkSummary(link)}`}
    >
      <span className={`dot ${linkTone(link)}`} aria-hidden="true" />
      <span className="linkbar-main">
        <span className="linkbar-name">{name}</span>
        <span className="linkbar-state">{linkSummary(link)}</span>
      </span>
      <span className="chev" aria-hidden="true">
        <StudioIcon name="down" />
      </span>
    </button>
  );
}

/**
 * 切换连接: the computers already paired, plus the two ways to do something
 * about the current one — retry a failure, or go to the settings screen where
 * pairing, sign-in and forgetting live.
 */
function SwitchSheet({
  link,
  saved,
  fleet,
  onClose,
  onSwitch,
  onRetry,
  onManage,
  onReorder,
}: {
  link: LinkState;
  saved: SavedConnection[];
  /** Live reachability of the saved computers, when the proxy watches them. */
  fleet?: FleetSnapshot;
  onClose: () => void;
  onSwitch: (entry: SavedConnection) => void;
  onRetry: () => void;
  onManage: () => void;
  /** A drop that changed the order, already written to storage. */
  onReorder: (rows: SavedConnection[]) => void;
}) {
  const busy = link.phase === "connecting" || link.phase === "reconnecting";
  useBackCloser(true, onClose);
  // The sheet is the scroller: it caps its own height rather than sitting in
  // the page body, so a drag near its edge has to scroll it.
  const drag = useRowDrag<HTMLUListElement>({
    rows: saved.map((entry) => ({
      key: connectionKey(entry.kind, entry.target),
      movable: true,
    })),
    enabled: !busy,
    scrollerSelector: ".sheet",
    place: (key, index) => onReorder(moveConnection(key, index)),
  });
  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        className="sheet switch-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="切换连接"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>切换连接</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <p className="switch-state">{linkSummary(link)}</p>
        {link.error ? (
          <div className="notice error">
            <div>{link.error.message}</div>
            {link.error.detail ? <div className="meta">{link.error.detail}</div> : null}
          </div>
        ) : null}
        {saved.length > 0 ? (
          <ul
            className="sheet-actions switch-list"
            ref={drag.listRef}
            data-dragging={drag.state ? "true" : undefined}
          >
            {saved.map((entry, index) => {
              const key = connectionKey(entry.kind, entry.target);
              const here = link.phase === "connected" && link.target === entry.target;
              const opening = busy && link.target === entry.target;
              const peer = fleet?.peers.find(
                (candidate) =>
                  candidate.kind === entry.kind &&
                  originKey(candidate.kind, candidate.target) === originKey(entry.kind, entry.target),
              );
              const tone = peer ? peerTone(peer.state) : null;
              const sub = entry.kind === "lan"
                ? `局域网 · ${entry.target}`
                : "云端 · Reasonix 账号";
              const stateText = peer
                ? { online: "在线", offline: "不可达", unauthorized: "配对失效", unwatchable: "不可监控", unknown: "" }[peer.state]
                : "";
              const shift = dragShift(drag.state, index);
              return (
                <li
                  key={key}
                  data-drag-key={key}
                  data-drop={dropEdge(drag.state, index, saved.length)}
                  className={drag.state?.key === key ? "dragging" : undefined}
                  style={shift === 0 ? undefined : { transform: `translateY(${shift}px)` }}
                  {...drag.row(key)}
                >
                  <button
                    type="button"
                    className="switch-row"
                    aria-current={here ? "true" : undefined}
                    disabled={busy}
                    onClick={() => onSwitch(entry)}
                  >
                    {tone ? <span className={`dot ${tone}`} aria-hidden="true" /> : null}
                    <span className="switch-main">
                      <span className="switch-name">
                        {entry.name}
                        {here ? <span className="current-tag">当前</span> : null}
                        {opening ? <span className="current-tag">连接中</span> : null}
                      </span>
                      <span className="switch-sub">{[sub, stateText].filter(Boolean).join(" · ")}</span>
                    </span>
                    <span className="chev" aria-hidden="true">
                      ›
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="meta">还没有连接过的电脑。</p>
        )}
        {saved.length > 1 ? <p className="group-note">按住一行拖动可以调整重连顺序。</p> : null}
        <div className="switch-foot">
          {link.phase === "failed" || link.phase === "reconnecting" ? (
            <button type="button" className="chip" onClick={onRetry}>
              重试连接
            </button>
          ) : null}
          {link.phase === "offline" ? (
            // The wait is usually the network's, not the link's, so the retry
            // is offered as a fallback rather than the main action: a phone
            // that regained Wi-Fi while the app was paused can miss the event
            // that would have woken this machine by itself.
            <button type="button" className="chip" onClick={onRetry}>
              仍然重试
            </button>
          ) : null}
          <button type="button" className="chip accent" onClick={onManage}>
            连接新电脑
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * The other watched computers, one row each.
 *
 * It sits between the link bar and the search field: which computers are
 * listening decides what the lists below mean, the same way the active
 * connection does. A computer with nothing blocked or running is quiet — the
 * block is "what needs you elsewhere", not a device manager.
 */
function FleetBar({
  fleet,
  onOpen,
}: {
  fleet: FleetSnapshot;
  onOpen: (item: FleetPendingItem | FleetRunningItem) => void;
}) {
  const blocked = fleet.pending.filter((item) => item.peer !== fleet.active);
  const working = fleet.running.filter((item) => item.peer !== fleet.active);
  const names = new Map<number, string>();
  for (const item of [...blocked, ...working]) names.set(item.peer, item.peerName);
  const peers = [...names.keys()].sort((a, b) => a - b);
  if (peers.length === 0) return null;
  return (
    <section className="fleet" aria-label="其他电脑">
      {peers.map((peer) => {
        const peerBlocked = blocked.filter((item) => item.peer === peer);
        const peerWorking = working.filter((item) => item.peer === peer);
        const row = peerBlocked[0] ?? peerWorking[0];
        if (!row) return null;
        const peerState = fleet.peers.find((candidate) => candidate.index === peer)?.state ?? "unknown";
        const label = peerBlocked.length > 0
          ? `${peerBlocked.length} 个待处理`
          : "正在运行";
        return (
          <button
            key={peer}
            type="button"
            className="fleet-row"
            onClick={() => onOpen(row)}
            aria-label={`${row.peerName}：${label}，点按切换`}
          >
            <span className={`dot ${peerTone(peerState)}`} aria-hidden="true" />
            <span className="fleet-main">
              <span className="fleet-name">
                {row.peerName}
              <span className="fleet-tag" data-kind={peerBlocked.length > 0 ? "blocked" : "running"}>
                {label}
              </span>
              </span>
              <span className="fleet-sub">
                {peerBlocked.length > 0 && peerWorking.length > 0
                  ? `${peerWorking.length} 个运行中 · ${row.title}`
                  : row.title}
              </span>
            </span>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </button>
        );
      })}
    </section>
  );
}

function ProjectItem({
  project,
  drop,
  dragging,
  shift,
  drag,
  onOpen,
}: {
  project: TreeProject;
  drop: "before" | "after" | undefined;
  dragging: boolean;
  shift: number;
  drag: RowDragHandlers;
  onOpen: () => void;
}) {
  const when = relativeTime(projectActivity(project));
  return (
    <li
      data-project-root={project.root}
      data-drag-key={project.root}
      data-drop={drop}
      className={dragging ? "dragging" : undefined}
      style={shift === 0 ? undefined : { transform: `translateY(${shift}px)` }}
      {...drag}
    >
      <button type="button" className="project" onClick={onOpen}>
        <span className="project-mark" aria-hidden="true">{project.name.slice(0, 1)}</span>
        <span className="row-main">
          <span className="project-name">
            <span className="row-title">{project.name}</span>
            {project.open ? (
              <span className="dot ok" role="img" aria-label="桌面端已打开" title="桌面端已打开" />
            ) : null}
            {project.missing ? <span className="pill">文件夹不见了</span> : null}
          </span>
          <span className="project-path">{project.root}</span>
          <span className="project-meta">
            {summary(project)}
            {when ? ` · ${when}` : ""}
          </span>
        </span>
        <Chevron />
      </button>
    </li>
  );
}

/**
 * Dispatch as a page rather than a sheet: the tab is one of the three home
 * destinations, so the form has room to breathe and the bottom nav stays put.
 * The fields and the failure text are the ones the sheet used.
 */
export function Home({
  snapshot,
  tree,
  pending,
  tab,
  onTabChange,
  link,
  onSwitchConnection,
  onRetryLink,
  onOpenProject,
  onOpenSession,
  onOpenRuntime,
  onDispatch,
  onRefresh,
  onSettings,
  fleet,
  onOpenFleet,
}: HomeProps) {
  const [sessionQuery, setSessionQuery] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const [switchSheet, setSwitchSheet] = useState(false);
  /** The dispatch page is a third view, not a sheet: it has a tab of its own. */
  const [dispatchOpen, setDispatchOpen] = useState(false);
  /** Read when the sheet opens, so a settings change is reflected next time. */
  const [saved, setSaved] = useState<SavedConnection[]>([]);
  const [busy, setBusy] = useState("");
  /** The conversation whose actions are showing, if any. */
  const [menu, setMenu] = useState<RecentRow | null>(null);
  /** The project whose order is being written. */
  const [moveBusy, setMoveBusy] = useState("");
  const [error, setError] = useState("");
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** Finger travel for pull-to-refresh; a ref so release reads the latest. */
  const pullStart = useRef<number | null>(null);
  const pullAmount = useRef(0);
  const pulled = useRef(false);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refreshStart = useRef(0);
  const refreshTimer = useRef<number | null>(null);
  /** The view that was showing before this one, for the slide direction. */
  const previousTab = useRef(tab);
  const direction = tab === previousTab.current ? "none" : tab === "projects" ? "forward" : "back";

  useEffect(() => {
    previousTab.current = tab;
  }, [tab]);

  // The dispatch page is a destination, so the system back returns to the
  // list instead of leaving the app.
  useBackCloser(dispatchOpen, () => setDispatchOpen(false));

  const recent = useMemo(() => recentConversations(tree.projects), [tree.projects]);
  const linkName = useMemo(() => {
    if (!link.target) return link.name;
    const rows = loadConnections();
    const mode = link.mode ?? "lan";
    const row = rows.find((entry) => entry.kind === mode && entry.target === link.target);
    return row?.machine ?? row?.name ?? link.name;
  }, [link.mode, link.name, link.target]);
  const needle = (tab === "recent" ? sessionQuery : projectQuery).trim().toLowerCase();
  const shownRecent = needle ? recent.filter((row) => sessionMatches(row, needle)) : recent;
  const shownProjects = needle
    ? tree.projects.filter((project) => projectMatches(project, needle))
    : tree.projects;

  const open = async (project: TreeProject, session?: TreeSession) => {
    if (busy) return;
    const key = session?.path ?? project.root;
    setBusy(key);
    setError("");
    const result = await openRuntime(project.root, session?.path);
    setBusy("");
    if (!result.ok) {
      setError(runtimeOpenMessage(result.code));
      return;
    }
    onOpenSession(result.runtime.id, project.root, session ? sessionTitle(session) : "新会话");
  };

  /**
   * Pin or unpin one conversation.
   *
   * The write goes to the kernel first and the tree is re-read after it lands:
   * a local toggle would draw the pin before the kernel agreed, and a pin the
   * kernel refused is exactly the case where the row must not move.
   */
  const togglePin = async (row: RecentRow): Promise<TreeWrite> => {
    const result = await setPinned(row.session.path, row.session.pinned !== true);
    if (result.ok) onRefresh();
    return result;
  };

  const rename = async (row: RecentRow, title: string): Promise<TreeWrite> => {
    const result = await renameSession(row.session.path, title);
    if (result.ok) onRefresh();
    return result;
  };

  const remove = async (row: RecentRow): Promise<TreeWrite> => {
    const result = await removeSession(row.session.path);
    if (result.ok) onRefresh();
    return result;
  };

  const moveTo = async (row: RecentRow, target: string): Promise<TreeWrite> => {
    const result = await moveSessionTo(row.session.path, target);
    if (result.ok) onRefresh();
    return result;
  };

  const toggleArchive = async (row: RecentRow): Promise<TreeWrite> => {
    const result = await setArchived(row.session.path, true);
    if (result.ok) onRefresh();
    return result;
  };

  /**
   * Put one project where it was dropped.
   *
   * The desktop's list is the source of truth, so this asks for a placement
   * and re-reads rather than reordering a local copy: a refusal (an
   * unremembered folder, a project with a running turn) must leave the order
   * untouched.
   */
  const placeProjectAt = async (root: string, before: string) => {
    setMoveBusy(root);
    setError("");
    const result = await placeProject(root, before);
    setMoveBusy("");
    if (!result.ok) {
      setError(treeWriteMessage(result.code));
      return;
    }
    onRefresh();
  };

  const drag = useRowDrag<HTMLUListElement>({
    rows: shownProjects.map((project) => ({
      key: project.root,
      movable: project.remembered === true,
    })),
    enabled: !needle && !moveBusy,
    // The kernel's write is "put this root before that one", so a slot from
    // the drop is translated here rather than stored as a position.
    place: (root, index) => {
      const before = dropBefore(
        shownProjects.map((project) => ({
          root: project.root,
          remembered: project.remembered === true,
        })),
        root,
        index,
      );
      if (before !== null) void placeProjectAt(root, before);
    },
  });

  const empty = needle
    ? false
    : tab === "recent"
      ? recent.length === 0
      : tree.projects.length === 0;

  const pullReset = () => {
    pullStart.current = null;
    pullAmount.current = 0;
    setPull(0);
  };

  const onTouchStart = (event: React.TouchEvent) => {
    if (dispatchOpen || refreshing || drag.state) return;
    const body = bodyRef.current;
    if (!body || body.scrollTop > 0) return;
    const target = event.target as Element | null;
    if (
      target !== null &&
      typeof target.closest === "function" &&
      target.closest("input, textarea")
    ) {
      return;
    }
    const start = event.touches[0];
    if (!start) return;
    pullStart.current = start.clientY;
    pullAmount.current = 0;
    pulled.current = false;
  };

  const onTouchMove = (event: React.TouchEvent) => {
    const start = pullStart.current;
    if (start === null || dispatchOpen || drag.state) return;
    const point = event.touches[0];
    if (!point) return;
    const dy = point.clientY - start;
    if (dy <= 0) {
      pullReset();
      return;
    }
    if (dy > 8) pulled.current = true;
    const amount = Math.min(72, dy * 0.6);
    pullAmount.current = amount;
    setPull(amount);
  };

  const onTouchEnd = () => {
    if (pullStart.current === null) return;
    const armed = pullAmount.current >= 48;
    pullReset();
    if (!armed || refreshing) return;
    refreshStart.current = tree.revision;
    setRefreshing(true);
    onRefresh();
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      setRefreshing(false);
    }, 8_000);
  };

  useEffect(() => {
    if (!refreshing) return;
    if (tree.revision === refreshStart.current) return;
    if (refreshTimer.current !== null) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
    setRefreshing(false);
  }, [refreshing, tree.revision]);

  useEffect(() => () => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
  }, []);

  const onBodyClick = (event: React.MouseEvent) => {
    if (!pulled.current) return;
    pulled.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="shell">
      <div className="topline">
        <span className="top-brand" aria-hidden="true"><BrandMark /></span>
        <LinkBar
          link={link}
          name={linkName}
          onOpen={() => {
            setSaved(loadConnections());
            setSwitchSheet(true);
          }}
        />
        {onSettings ? (
          <button type="button" className="iconbtn top-gear" onClick={onSettings} aria-label="设置">
            <StudioIcon name="settings" />
          </button>
        ) : null}
      </div>

      {fleet && onOpenFleet ? <FleetBar fleet={fleet} onOpen={onOpenFleet} /> : null}

      <div
        ref={bodyRef}
        className={dispatchOpen ? "body dispatch-body" : "body"}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onClickCapture={onBodyClick}
      >
        {pull > 0 || refreshing ? (
          <div
            className={`pull-hint${refreshing ? " loading" : ""}`}
            style={{ height: refreshing ? 36 : Math.round(pull) }}
          >
            {refreshing ? "正在刷新…" : pullAmount.current >= 48 ? "松开刷新" : "下拉刷新"}
          </div>
        ) : null}
        {dispatchOpen ? null : <ReachBanner snapshot={snapshot} />}

        {dispatchOpen ? (
          onDispatch ? (
            <DispatchPage
              projects={tree.projects}
              computerName={linkName}
              notify={link.mode !== "cloud"}
              onDispatch={onDispatch}
              onSent={(result) => {
                const after = loadDispatchAfter();
                if (after === "recent") {
                  setDispatchOpen(false);
                  onTabChange("recent");
                  return;
                }
                if (after === "session" && result.runtimeId) {
                  setDispatchOpen(false);
                  onOpenRuntime(
                    result.runtimeId,
                    result.root ?? "",
                    result.title ?? "派发的任务",
                  );
                }
              }}
            />
          ) : (
            <div className="centered">
              <div>这个版本还没有派发能力。</div>
            </div>
          )
        ) : (
          <>
            {tab === "recent" ? (
              <input
                className="search"
                type="search"
                value={sessionQuery}
                onChange={(event) => setSessionQuery(event.target.value)}
                placeholder="搜索会话"
                aria-label="搜索会话"
              />
            ) : null}

            {tab === "projects" ? (
              <>
                <div className="section-head home-head">
                  <h2>项目</h2>
                  <span className="meta">{shownProjects.length}</span>
                </div>
                <input
                  className="search"
                  type="search"
                  value={projectQuery}
                  onChange={(event) => setProjectQuery(event.target.value)}
                  placeholder="搜索项目"
                  aria-label="搜索项目"
                />
              </>
            ) : null}

            <div className="home-view" data-dir={direction} key={tab}>
              {/* Only the recent view carries it: "what needs me" is about
                  conversations, not about folders. */}
              {tab === "recent" && !needle ? (
                <NeedsYou
                  pending={pending}
                  computerName={linkName}
                  onOpen={(item) => onOpenRuntime(item.runtimeId, item.projectRoot, item.title)}
                />
              ) : null}

              {tree.status === "failed" ? (
                <div className="notice error">
                  <div>读不到项目列表</div>
                  <div className="meta">{tree.code}</div>
                </div>
              ) : null}

              {error ? <div className="notice error">{error}</div> : null}

              {tree.status === "loading" && tree.projects.length === 0 ? (
                <div className="centered">
                  <div>正在读取项目…</div>
                </div>
              ) : null}

              {empty ? (
                <div className="centered">
                  <div>
                    <strong>{tab === "recent" ? "还没有会话" : "还没有项目"}</strong>
                    {tab === "recent"
                      ? "在桌面端开始一个会话，这里就会出来。"
                      : "在桌面端打开一个项目，这里就会出来。"}
                  </div>
                </div>
              ) : null}

              {tab === "recent" && shownRecent.length > 0 ? (
                <>
                  <div className="section-head home-head">
                    <h2>最近</h2>
                    <span className="meta">{shownRecent.length}</span>
                  </div>
                  <ul className="list grouped">
                    {shownRecent.map((row) => (
                      <RecentItem
                        key={`${row.project.root}\u0000${row.session.path}`}
                        row={row}
                        busy={busy === row.session.path}
                        onOpen={() => void open(row.project, row.session)}
                        onMenu={() => setMenu(row)}
                      />
                    ))}
                  </ul>
                </>
              ) : null}

              {tab === "projects" && shownProjects.length > 0 ? (
                <ul
                  className="list grouped"
                  ref={drag.listRef}
                  data-dragging={drag.state ? "true" : undefined}
                >
                  {shownProjects.map((project, index) => (
                    <ProjectItem
                      key={project.root}
                      project={project}
                      drop={dropEdge(drag.state, index, shownProjects.length)}
                      dragging={drag.state?.key === project.root}
                      shift={dragShift(drag.state, index)}
                      drag={drag.row(project.root)}
                      onOpen={() => onOpenProject(project.root)}
                    />
                  ))}
                </ul>
              ) : null}

              {needle && shownRecent.length === 0 && (tab === "recent" || shownProjects.length === 0) ? (
                <div className="centered">
                  <div>
                    <strong>没有匹配</strong>
                    换个词试试。
                  </div>
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>

      <nav className="tabbar" aria-label="主导航">
        <button
          type="button"
          className={!dispatchOpen && tab === "recent" ? "on" : undefined}
          aria-current={!dispatchOpen && tab === "recent" ? "page" : undefined}
          onClick={() => {
            setDispatchOpen(false);
            onTabChange("recent");
          }}
        >
          <StudioIcon name="list" />
          <span>最近</span>
        </button>
        <button
          type="button"
          className={!dispatchOpen && tab === "projects" ? "on" : undefined}
          aria-current={!dispatchOpen && tab === "projects" ? "page" : undefined}
          onClick={() => {
            setDispatchOpen(false);
            onTabChange("projects");
          }}
        >
          <StudioIcon name="grid" />
          <span>项目</span>
        </button>
        <button
          type="button"
          className={dispatchOpen ? "on" : undefined}
          aria-current={dispatchOpen ? "page" : undefined}
          onClick={() => setDispatchOpen(true)}
        >
          <StudioIcon name="send" />
          <span>派发</span>
        </button>
      </nav>

      {menu ? (
        <SessionSheet
          title={sessionTitle(menu.session)}
          projectName={menu.project.name}
          when={relativeTime(menu.session.lastActiveAt)}
          pinned={menu.session.pinned === true}
          projects={tree.projects}
          projectRoot={menu.project.root}
          busy={busy === menu.session.path}
          deleteWarning={deleteWarning(menu.session)}
          onClose={() => setMenu(null)}
          onOpen={() => {
            const row = menu;
            setMenu(null);
            void open(row.project, row.session);
          }}
          onTogglePin={() => togglePin(menu)}
          onRename={(title) => rename(menu, title)}
          onMoveTo={(target) => moveTo(menu, target)}
          onToggleArchive={() => toggleArchive(menu)}
          onRemove={() => remove(menu)}
        />
      ) : null}

      {switchSheet ? (
        <SwitchSheet
          link={link}
          saved={saved}
          {...(fleet ? { fleet } : {})}
          onClose={() => setSwitchSheet(false)}
          onSwitch={(entry) => {
            setSwitchSheet(false);
            onSwitchConnection(entry);
          }}
          onRetry={onRetryLink}
          onReorder={setSaved}
          onManage={() => {
            setSwitchSheet(false);
            onSettings?.();
          }}
        />
      ) : null}
    </div>
  );
}
