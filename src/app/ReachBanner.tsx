/**
 * Why the list is not showing what it should.
 *
 * Reachability leads because every other control on a list screen is judged
 * against it: a project that cannot be opened must not look like an
 * invitation. Both the project list and a project's conversation list show the
 * same banner, so the explanation cannot drift between them.
 */

import type { ConnectionSnapshot } from "../net/connection";

export function ReachBanner({ snapshot }: { snapshot: ConnectionSnapshot }) {
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
