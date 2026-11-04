/**
 * The second level: one project's conversations.
 *
 * A conversation row is a stored transcript, not a pane. That distinction is
 * the whole point of this screen: the desktop may have no pane open at all and
 * the phone can still show — and open — every conversation the project has.
 * Tapping one asks the hub to bind that transcript; tapping "新会话" asks it
 * for a fresh one in the same folder.
 *
 * Rows whose `runtimeId` is set are the ones a pane is driving right now. They
 * are drawn as open rather than special-cased: the kernel answers the same
 * runtime for them, so the tap costs nothing.
 *
 * A row can also carry transcripts that stay under it — conflict-recovery
 * copies and earlier versions — and the desktop folds those away behind a
 * "+N" rather than listing them beside the conversation. The same fold here
 * keeps one conversation from reading as two identical rows, which is exactly
 * what a phone list made of bare titles cannot explain on its own.
 */

import { useState } from "react";
import type { ConnectionSnapshot } from "../net/connection";
import { openRuntime } from "../net/workspaces";
import { moveSessionTo, removeSession, renameSession, setArchived, setPinned } from "../net/pin";
import type { TreeWrite } from "../net/pin";
import { loadTree } from "../net/tree";
import type { TreeProject, TreeSession, TreeSessionChild } from "../wire/tree";
import { ReachBanner } from "./ReachBanner";
import { relativeTime } from "./format";
import { useLongPress } from "./longPress";
import { SessionSheet } from "./SessionSheet";
import type { TreeState } from "./useTree";

export interface SessionListProps {
  snapshot: ConnectionSnapshot;
  tree: TreeState;
  project: TreeProject;
  onBack: () => void;
  /** A pane is open (or was just opened) on this conversation. */
  onOpen: (runtimeId: string, title: string) => void;
  onRefresh: () => void;
}

/** A stable, readable label: the generated title, else the file stem. */
export function sessionTitle(session: TreeSession): string {
  return session.title?.trim() || session.name;
}

/** A kernel refusal, as a sentence a person can act on. */
export function runtimeOpenMessage(code: string): string {
  switch (code) {
    case "device.host_only":
      return "桌面端不允许手机打开这个会话。";
    case "client.offline":
      return "连不上电脑，检查连接后重试。";
    case "client.timeout":
      return "等电脑回应超时，检查连接后重试。";
    case "client.empty_root":
      return "这个项目没有路径。";
    case "runtime.shape":
      return "桌面端返回了无法识别的会话。";
    case "session.running":
      return "这个会话正在桌面端跑，等它停下再打开。";
    case "session.unknown":
      return "这个会话的文件已经不在了。";
    case "session.pending_cleanup":
      return "这个会话正在被清理，稍后再试。";
    case "workspace.none":
      return "桌面端没有可以打开的项目。";
    default:
      return `打不开：${code}`;
  }
}

/**
 * What the fold holds, oldest reason first: an earlier version is this
 * conversation before a rewind, a recovery copy is a second file a write
 * conflict left behind. Both open as their own transcript, so they share a
 * row shape and differ only in how they are named.
 */
interface Folded {
  child: TreeSessionChild;
  version: boolean;
}

/**
 * Everything a row keeps under itself, in the order the fold shows it, keyed by
 * path. The two lists are separate on the wire and nothing stops a kernel from
 * naming one transcript in both, so a repeated path keeps its first place
 * rather than rendering a second row with the same key.
 */
function foldedRows(session: TreeSession): Folded[] {
  const seen = new Set<string>();
  const out: Folded[] = [];
  const add = (child: TreeSessionChild, version: boolean) => {
    if (seen.has(child.path)) return;
    seen.add(child.path);
    out.push({ child, version });
  };
  for (const child of session.versions ?? []) add(child, true);
  for (const child of session.copies ?? []) add(child, false);
  return out;
}

/**
 * The word beside a folded row. An earlier version says how long it ran — that
 * is what tells two of them apart. A recovery copy does not: its turn count is
 * the conversation's own and would read as the same conversation.
 */
function foldedLabel(row: Folded): string {
  const turns = row.child.turns;
  return row.version ? (turns ? `早先版本 · ${turns} 轮` : "早先版本") : "恢复副本";
}

/**
 * Why a row carries copies, in the words the fold's own button can use, with
 * the count so the button says what it will open.
 */
function foldedHint(session: TreeSession): string {
  const versions = session.versions?.length ?? 0;
  const copies = session.copies?.length ?? 0;
  if (versions > 0 && copies > 0) return `${versions} 个早先版本、${copies} 份恢复副本`;
  if (versions > 0) return `${versions} 个早先版本：编辑、重新生成或回退之前的对话`;
  return `${copies} 份恢复副本：本次对话被外部程序改写时留下`;
}

/**
 * What a delete of the parent row leaves behind: copies holding content the
 * conversation itself lacks are kept by the kernel, so the warning has to say
 * so before the tap, not after it. The recent list deletes through the same
 * sheet, so it asks this too rather than guessing the row has no copies.
 */
export function deleteWarning(session: TreeSession): string {
  const copies = session.copies?.length ?? 0;
  const base = "删除后这个会话的转录会从电脑上移除，不能撤销。正在运行的会话不能删除。";
  if (copies === 0) return base;
  return `还有 ${copies} 份恢复副本带着这个会话没有的内容，删除这个会话会保留它们。${base}`;
}

function SessionRow({
  session,
  busy,
  childBusy,
  expanded,
  onOpen,
  onMenu,
  onToggleFold,
  onOpenChild,
}: {
  session: TreeSession;
  busy: boolean;
  /** The path of a folded row that is opening, if one is. */
  childBusy: string;
  expanded: boolean;
  onOpen: () => void;
  onMenu: () => void;
  onToggleFold: () => void;
  onOpenChild: (child: TreeSessionChild) => void;
}) {
  const when = relativeTime(session.lastActiveAt);
  const press = useLongPress(onMenu);
  const folded = foldedRows(session);
  return (
    <>
      <li>
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
          <span className="row-main">
            <span className="session-name">
              {sessionTitle(session)}
              {session.unread ? (
                <span className="dot accent" role="img" aria-label="有新回答" title="有新回答" />
              ) : null}
              {session.runtimeId ? <span className="pill">运行中</span> : null}
              {session.legacy ? <span className="pill">旧版</span> : null}
            </span>
            <span className="session-meta">
              {busy ? "正在打开…" : [when, session.turns ? `${session.turns} 轮` : ""].filter(Boolean).join(" · ")}
            </span>
          </span>
          <span className="chev" aria-hidden="true">
            ›
          </span>
        </button>
        {/* The fold is a sibling of the row, not a target inside it: a control
            nested in a button is announced as two buttons and cannot be
            reached by touch without stealing the row's own tap. */}
        {folded.length > 0 ? (
          <button
            type="button"
            className="fold"
            aria-expanded={expanded}
            aria-label={foldedHint(session)}
            title={foldedHint(session)}
            onClick={onToggleFold}
          >
            {expanded ? "−" : `+${folded.length}`}
          </button>
        ) : null}
      </li>
      {expanded
        ? folded.map((row) => (
            <li key={row.child.path} className="folded">
              {/* A folded row opens and nothing else. Pin and rename are the
                  conversation's own decisions and the kernel keys them to the
                  parent, so offering them here would ask about a row the sheet
                  cannot describe. */}
              <button
                type="button"
                className="session"
                onClick={() => onOpenChild(row.child)}
                disabled={childBusy === row.child.path}
              >
                <span className="row-main">
                  <span className="session-name">{foldedLabel(row)}</span>
                  <span className="session-meta" title={row.child.title || row.child.name}>
                    {childBusy === row.child.path ? "正在打开…" : row.child.title || row.child.name}
                  </span>
                </span>
                <span className="chev" aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          ))
        : null}
    </>
  );
}

export function SessionList({
  snapshot,
  tree,
  project,
  onBack,
  onOpen,
  onRefresh,
}: SessionListProps) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<TreeSession | null>(null);
  /** Whether the open menu belongs to a row of the archive, not the active list. */
  const [menuArchived, setMenuArchived] = useState(false);
  /** The archive, once the person has asked for it: null means "not shown". */
  const [archiveList, setArchiveList] = useState<{ loading: boolean; sessions: TreeSession[] } | null>(
    null,
  );
  const [archiveError, setArchiveError] = useState("");
  /** The rows whose fold is open, by transcript path. */
  const [spread, setSpread] = useState<Set<string>>(new Set());

  const open = async (session?: TreeSession | TreeSessionChild) => {
    if (busy) return;
    const key = session?.path ?? "__new__";
    setBusy(key);
    setError("");
    const result = await openRuntime(project.root, session?.path);
    setBusy("");
    if (!result.ok) {
      setError(runtimeOpenMessage(result.code));
      return;
    }
    onOpen(result.runtime.id, session ? session.title?.trim() || session.name : "新会话");
  };

  const togglePin = async (session: TreeSession): Promise<TreeWrite> => {
    const result = await setPinned(session.path, session.pinned !== true);
    if (result.ok) onRefresh();
    return result;
  };

  const rename = async (session: TreeSession, title: string): Promise<TreeWrite> => {
    const result = await renameSession(session.path, title);
    if (result.ok) onRefresh();
    return result;
  };

  const remove = async (session: TreeSession): Promise<TreeWrite> => {
    const result = await removeSession(session.path);
    if (result.ok) onRefresh();
    return result;
  };

  const moveTo = async (session: TreeSession, target: string): Promise<TreeWrite> => {
    const result = await moveSessionTo(session.path, target);
    if (result.ok) {
      onRefresh();
      // The moved row may have been one of the archived ones; both lists can
      // have changed, so the next time the archive is opened it re-reads.
      setArchiveList(null);
    }
    return result;
  };

  const toggleArchive = async (session: TreeSession): Promise<TreeWrite> => {
    const result = await setArchived(session.path, menuArchived !== true);
    if (result.ok) {
      onRefresh();
      // An archive takes the row out of the active lists; a restore puts it
      // back. Either way the archive's own list is stale the moment it lands.
      setArchiveList(null);
    }
    return result;
  };

  /**
   * The archived rows of this project, fetched on demand.
   *
   * One scoped read answers every project; the phone keeps only its own. A
   * repeat visit re-reads rather than caching, because archives change from
   * both sides — the desktop archives, the phone restores.
   */
  const toggleArchiveList = async () => {
    if (archiveList !== null) {
      setArchiveList(null);
      return;
    }
    setArchiveList({ loading: true, sessions: [] });
    setArchiveError("");
    const result = await loadTree({ scope: "archived", limit: 60 });
    if (!result.ok) {
      setArchiveList(null);
      setArchiveError(result.code);
      return;
    }
    const own = result.projects.find((entry) => entry.root === project.root);
    setArchiveList({ loading: false, sessions: own?.sessions ?? [] });
  };

  const toggleFold = (path: string) => {
    setSpread((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const sessions = project.sessions;
  const hidden = project.remaining;

  return (
    <div className="shell">
      <div className="bar">
        <button type="button" className="iconbtn" onClick={onBack} aria-label="返回项目列表">
          ←
        </button>
        <h1>{project.name}</h1>
        <button type="button" className="iconbtn" onClick={onRefresh} aria-label="刷新">
          ⟳
        </button>
      </div>

      <div className="body">
        <ReachBanner snapshot={snapshot} />

        <div className="project-head">
          <span className="meta">{project.root}</span>
          <button
            type="button"
            className="primary"
            onClick={() => void open()}
            disabled={busy !== "" || project.missing === true}
          >
            {busy === "__new__" ? "正在新建…" : "新会话"}
          </button>
        </div>

        {error ? <div className="notice error">{error}</div> : null}
        {project.missing ? <div className="notice warn">这个文件夹已经不在电脑上了。</div> : null}

        <div className="section-head">
          <h2>会话</h2>
          <span className="meta">{project.total}</span>
        </div>

        {sessions.length === 0 ? (
          <div className="centered">
            <div>
              <strong>还没有会话</strong>
              点「新会话」在这个项目里开始一个。
            </div>
          </div>
        ) : (
          <ul className="list grouped">
            {sessions.map((session) => (
              <SessionRow
                key={session.path}
                session={session}
                busy={busy === session.path}
                childBusy={busy}
                expanded={spread.has(session.path)}
                onOpen={() => void open(session)}
                onMenu={() => {
                  setMenuArchived(false);
                  setMenu(session);
                }}
                onToggleFold={() => toggleFold(session.path)}
                onOpenChild={(child) => void open(child)}
              />
            ))}
          </ul>
        )}

        {hidden > 0 ? (
          <button
            type="button"
            className="more"
            onClick={() => tree.reload({ [project.root]: project.sessions.length + hidden })}
          >
            还有 {hidden} 个更早的会话
          </button>
        ) : null}

        {(project.archived ?? 0) > 0 || archiveList !== null ? (
          <>
            <div className="section-head">
              <h2>已归档</h2>
              <button
                type="button"
                className="more inline"
                aria-expanded={archiveList !== null}
                onClick={() => void toggleArchiveList()}
              >
                {archiveList === null
                  ? `看 ${project.archived} 个`
                  : archiveList.loading
                    ? "读取中…"
                    : "收起"}
              </button>
            </div>
            {archiveError ? <div className="notice error">{archiveError}</div> : null}
            {archiveList !== null && !archiveList.loading ? (
              archiveList.sessions.length === 0 ? (
                <div className="meta archived-empty">没有已归档的会话。</div>
              ) : (
                <ul className="list grouped">
                  {archiveList.sessions.map((session) => (
                    <SessionRow
                      key={session.path}
                      session={session}
                      busy={busy === session.path}
                      childBusy={busy}
                      expanded={spread.has(session.path)}
                      onOpen={() => void open(session)}
                      onMenu={() => {
                        setMenuArchived(true);
                        setMenu(session);
                      }}
                      onToggleFold={() => toggleFold(session.path)}
                      onOpenChild={(child) => void open(child)}
                    />
                  ))}
                </ul>
              )
            ) : null}
          </>
        ) : null}
      </div>

      {menu ? (
        <SessionSheet
          title={sessionTitle(menu)}
          projectName={project.name}
          when={relativeTime(menu.lastActiveAt)}
          pinned={menu.pinned === true}
          archived={menuArchived}
          projects={tree.projects}
          projectRoot={project.root}
          busy={busy === menu.path}
          deleteWarning={deleteWarning(menu)}
          onClose={() => setMenu(null)}
          onOpen={() => {
            const session = menu;
            setMenu(null);
            void open(session);
          }}
          onTogglePin={() => togglePin(menu)}
          onRename={(title) => rename(menu, title)}
          onMoveTo={(target) => moveTo(menu, target)}
          onToggleArchive={() => toggleArchive(menu)}
          onRemove={() => remove(menu)}
        />
      ) : null}
    </div>
  );
}
