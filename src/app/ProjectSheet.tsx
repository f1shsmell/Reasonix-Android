/**
 * The phone's whole "sessions and projects" surface: one sheet, two choices.
 *
 * A paired device may only open roots the desktop already knows, so this sheet
 * does not offer a folder picker. It shows the current project plus the
 * kernel's remembered projects; opening either asks the hub for a fresh
 * conversation. The old conversation is not closed.
 */

import { useCallback, useEffect, useState } from "react";
import { loadWorkspaces, openRuntime } from "../net/workspaces";
import type { WorkspaceInfo } from "../net/workspaces";

export interface ProjectSheetProps {
  base: string;
  root: string;
  onClose: () => void;
  onOpened: (runtimeId: string) => void;
}

function projectName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function message(code: string): string {
  switch (code) {
    case "device.host_only":
      return "桌面端不允许手机打开这个项目。";
    case "client.offline":
      return "连不上电脑，检查连接后重试。";
    case "client.empty_root":
      return "这个项目没有路径。";
    case "runtime.shape":
      return "桌面端返回了无法识别的会话。";
    case "workspace.changing_disabled":
      return "桌面端没有允许项目切换。";
    default:
      return `打不开：${code}`;
  }
}

export function ProjectSheet({ base, root, onClose, onOpened }: ProjectSheetProps) {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadWorkspaces(base).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result.ok) setInfo(result.info);
      else setLoadError(result.code);
    });
    return () => {
      cancelled = true;
    };
  }, [base]);

  const open = useCallback(
    async (path: string) => {
      if (!path || busy) return;
      setBusy(path);
      setError("");
      const result = await openRuntime(path);
      if (!result.ok) {
        setBusy("");
        setError(message(result.code));
        return;
      }
      setBusy("");
      onOpened(result.runtime.id);
    },
    [busy, onOpened],
  );

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="会话与项目"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>会话与项目</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="sheet-body">
          <div className="sheet-current">
            <strong>{projectName(root)}</strong>
            <span className="meta">{root}</span>
          </div>
          <button
            type="button"
            className="sheet-primary"
            onClick={() => void open(root)}
            disabled={busy !== ""}
          >
            {busy === root ? "正在打开…" : "在当前项目新建会话"}
          </button>

          {error ? <div className="notice error">{error}</div> : null}

          <div className="sheet-label">最近项目</div>
          {loading ? <div className="meta">正在读取最近项目…</div> : null}
          {loadError ? (
            <div className="meta">读不到最近项目：{message(loadError)}</div>
          ) : null}
          {!loading && info && info.recents.length === 0 ? (
            <div className="meta">没有其他最近项目。先在桌面端打开一个项目，它就会出现在这里。</div>
          ) : null}

          <ul className="projects">
            {info?.recents.map((project) => (
              <li key={project.path}>
                <button
                  type="button"
                  onClick={() => void open(project.path)}
                  disabled={busy !== ""}
                >
                  <span>{project.name}</span>
                  <small>{project.path}</small>
                  {busy === project.path ? <small>正在打开…</small> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
