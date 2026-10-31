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
 */

import { useState } from "react";
import type { ConnectionSnapshot } from "../net/connection";
import { openRuntime } from "../net/workspaces";
import { removeSession, renameSession, setPinned } from "../net/pin";
import type { TreeWrite } from "../net/pin";
import type { TreeProject, TreeSession } from "../wire/tree";
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

function SessionRow({
  session,
  busy,
  onOpen,
  onMenu,
}: {
  session: TreeSession;
  busy: boolean;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const when = relativeTime(session.lastActiveAt);
  const press = useLongPress(onMenu);
  return (
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
    </li>
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

  const open = async (session?: TreeSession) => {
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
    onOpen(result.runtime.id, session ? sessionTitle(session) : "新会话");
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
                onOpen={() => void open(session)}
                onMenu={() => setMenu(session)}
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
      </div>

      {menu ? (
        <SessionSheet
          title={sessionTitle(menu)}
          projectName={project.name}
          when={relativeTime(menu.lastActiveAt)}
          pinned={menu.pinned === true}
          busy={busy === menu.path}
          onClose={() => setMenu(null)}
          onOpen={() => {
            const session = menu;
            setMenu(null);
            void open(session);
          }}
          onTogglePin={() => togglePin(menu)}
          onRename={(title) => rename(menu, title)}
          onRemove={() => remove(menu)}
        />
      ) : null}
    </div>
  );
}
