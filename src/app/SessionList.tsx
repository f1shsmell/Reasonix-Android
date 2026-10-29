/**
 * The session list: what a person opens the app to see.
 *
 * Reachability lives at the top because every other control is judged against
 * it. A list of sessions that cannot be opened is worse than an empty one, so
 * the reason leads when there is one.
 */

import type { ConnectionSnapshot } from "../net/connection";
import type { RuntimeView } from "../wire/runtime";

export interface SessionListProps {
  snapshot: ConnectionSnapshot;
  onOpen: (runtimeId: string) => void;
  onRefresh: () => void;
  /** Open the connection/account screen (sign-in, LAN switch, cloud devices). */
  onSettings?: () => void;
  /** Open the new-session / project sheet. */
  onNew?: () => void;
}

function ReachBanner({ snapshot }: { snapshot: ConnectionSnapshot }) {
  switch (snapshot.reach.kind) {
    case "unauthorized":
      return (
        <div className="notice warn">
          <div>需要令牌</div>
          <details>
            <summary>怎么办</summary>
            <div>
              在桌面上打开 Reasonix，从「设备访问」里扫码，或者把带
              <code> #token= </code>
              的链接贴到这个浏览器里。
            </div>
          </details>
        </div>
      );
    case "unreachable":
      return (
        <div className="notice error">
          <div>连不上这台电脑</div>
          <details>
            <summary>详情</summary>
            <div>{snapshot.reach.detail}</div>
          </details>
        </div>
      );
    case "ok":
      return null;
    default:
      return <div className="notice">正在连接…</div>;
  }
}

function SessionRow({ runtime, onOpen }: { runtime: RuntimeView; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className="session" onClick={onOpen}>
        <span className="session-name">
          {runtime.name}
          {runtime.readOnly ? <span className="pill">只读</span> : null}
        </span>
        <span className="session-path">{runtime.root}</span>
      </button>
    </li>
  );
}

export function SessionList({ snapshot, onOpen, onRefresh, onSettings, onNew }: SessionListProps) {
  return (
    <div className="shell">
      <div className="bar">
        <span className={`dot ${snapshot.reach.kind === "ok" ? "ok" : "warn"}`} />
        <h1>Reasonix</h1>
        {onNew ? (
          <button type="button" className="iconbtn" onClick={onNew} aria-label="新建会话或切换项目">
            ＋
          </button>
        ) : null}
        {onSettings ? (
          <button type="button" className="iconbtn" onClick={onSettings} aria-label="连接与账号">
            ⚙
          </button>
        ) : null}
        <button type="button" className="iconbtn" onClick={onRefresh} aria-label="刷新">
          ⟳
        </button>
      </div>

      <div className="body">
        <ReachBanner snapshot={snapshot} />

        <div className="section-head">
          <h2>会话</h2>
          <span className="meta">{snapshot.runtimes.length}</span>
        </div>

        {snapshot.runtimes.length === 0 ? (
          <div className="centered">
            <div>
              <strong>没有打开的会话</strong>
              在桌面端打开一个项目，这里就会出来。
            </div>
          </div>
        ) : (
          <ul className="list">
            {snapshot.runtimes.map((runtime) => (
              <SessionRow
                key={runtime.id}
                runtime={runtime}
                onOpen={() => onOpen(runtime.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
