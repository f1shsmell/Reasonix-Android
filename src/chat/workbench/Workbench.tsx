import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionSnapshot } from "../../net/connection";
import {
  loadChanges,
  loadDiff,
  loadGitRepos,
  loadWorkspaceGit,
  stageChanges,
  stageMessage,
} from "../../net/changes";
import type { GitReposView, WorkspaceChanges, WorkspaceGitView } from "../../wire/changes";
import { buildTree } from "./gittree";
import { ChangesTree } from "./ChangesTree";
import type { DiffSlot } from "./ChangesTree";
import { CommitCard } from "./CommitCard";
import { HistorySection } from "./HistorySection";
import { FileBrowser } from "./FileBrowser";

/** One visible refresh signal, from any of the four sources that say the tree
 *  may have moved: the mount itself, a `workspace_changed` frame on the pane's
 *  stream, a finished non-read-only tool call (`wrote` prop), and the document
 *  becoming visible again. Writes settle: agent edits land in bursts, so the
 *  event-driven bump waits 700ms for the burst to finish. */
function useRevision(
  snapshot: ConnectionSnapshot,
  wrote: number,
): { revision: number; refresh: () => void } {
  const [revision, setRevision] = useState(0);
  const watermark = useRef(-1);
  const timer = useRef<number | null>(null);
  // The tool-call count at open: the transcript's total includes rows hydrated
  // from history, so only the growth past the opening number says "the agent
  // wrote to the tree while this workbench was on screen".
  const wroteAtOpen = useRef(wrote);
  const bump = useCallback((immediate = false): void => {
    if (immediate) {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      setRevision((value) => value + 1);
      return;
    }
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setRevision((value) => value + 1);
    }, 700);
  }, []);
  useEffect(() => {
    const unseen = snapshot.events.filter((entry) => entry.seq > watermark.current);
    if (unseen.length === 0) return;
    const last = unseen[unseen.length - 1];
    watermark.current = last?.seq ?? watermark.current;
    if (unseen.some((entry) => entry.event.kind === "workspace_changed")) bump();
  }, [snapshot.events, bump]);
  useEffect(() => {
    if (wrote > wroteAtOpen.current) bump();
  }, [wrote, bump]);
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === "visible") bump(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      // A bump scheduled but not yet fired has no owner after unmount.
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [bump]);
  return { revision, refresh: () => bump(true) };
}

/** Whether every change entry is wholly staged: the "stage all" flip point. */
function settledAll(changes: WorkspaceChanges): boolean {
  return (
    changes.changes.length > 0 &&
    changes.changes.every((entry) => entry.staged === true && entry.unstaged !== true)
  );
}

function uniquePaths(changes: WorkspaceChanges): number {
  return new Set(changes.changes.map((entry) => entry.path)).size;
}

export function Workbench({
  base,
  readOnly,
  snapshot,
  wrote,
  onClose,
}: {
  base: string;
  readOnly: boolean;
  snapshot: ConnectionSnapshot;
  /** How many non-read-only tool calls have finished this conversation; every
   *  bump is a hint that the agent wrote to the tree. */
  wrote: number;
  onClose: () => void;
}) {
  const { revision, refresh } = useRevision(snapshot, wrote);
  const [tab, setTab] = useState<"changes" | "files">("changes");

  // The repositories below the workspace. null with no error is an old kernel
  // whose /git/repos 404s: the workspace's own changes render as the one repo
  // it used to be. A real refusal keeps the workspace's own list too, with the
  // error said beside it.
  const [repos, setRepos] = useState<GitReposView["repos"] | null>(null);
  const [reposError, setReposError] = useState("");
  const [activeRepo, setActiveRepo] = useState("");
  /** True once the repo list has answered (or an old kernel's 404 fell back):
   *  the changes read waits for it, so a multi-repo workspace never flashes
   *  the root's `repo:false` answer before the real repo is selected. */
  const [reposReady, setReposReady] = useState(false);

  const [gitView, setGitView] = useState<WorkspaceGitView | null>(null);
  const [changes, setChanges] = useState<WorkspaceChanges | null>(null);
  const [changesError, setChangesError] = useState("");
  /** A stage refusal is not a read failure: it names its own fix, so it draws
   *  its own sentence and never the 重新读取 affordance. */
  const [stageError, setStageError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCommit, setShowCommit] = useState(false);
  /** The open diff, keyed to its repository: a repo switch invalidates it by
   *  key comparison instead of a reset effect that races the diff fetch. */
  const [open, setOpen] = useState<{ repo: string; path: string } | null>(null);
  const [slots, setSlots] = useState<Map<string, DiffSlot>>(new Map());
  const [jump, setJump] = useState<{ path: string; token: number } | null>(null);
  const openPath = open !== null && open.repo === activeRepo ? open.path : null;

  // The repo list: read per revision, single flight by effect discipline.
  useEffect(() => {
    let cancelled = false;
    void loadGitRepos(base).then((reply) => {
      if (cancelled) return;
      if (!reply.ok) {
        // 404/501 without a code is an old kernel: one repo, not a fault.
        setRepos(null);
        setReposError(reply.code === "http.404" || reply.code === "http.501" ? "" : reply.code);
        setReposReady(true);
        return;
      }
      setReposError("");
      setRepos(reply.value.repos);
      setReposReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [base, revision]);

  // Keep the active repo on a repo that exists; the first is the default.
  useEffect(() => {
    if (repos === null || repos.length === 0) return;
    if (repos.some((row) => row.dir === activeRepo)) return;
    setActiveRepo(repos[0]?.dir ?? "");
  }, [repos, activeRepo]);

  // A repository (or a pane) switch invalidates the diff slots; the open diff
  // itself is keyed to its repo and simply stops matching.
  useEffect(() => {
    setSlots(new Map());
  }, [base, activeRepo]);

  // The changes and the git identity of the active repository. Waiting for the
  // repo list first is what keeps a multi-repo workspace from flashing the
  // root's `repo:false` and tearing the section down for one paint.
  useEffect(() => {
    if (!reposReady) return;
    let cancelled = false;
    const repo = activeRepo || undefined;
    void loadChanges(base, repo).then((reply) => {
      if (cancelled) return;
      if (!reply.ok) {
        setChangesError(reply.code);
        return;
      }
      setChangesError("");
      setChanges(reply.value);
    });
    void loadWorkspaceGit(base, repo).then((reply) => {
      if (cancelled) return;
      setGitView(reply.ok ? reply.value : null);
    });
    return () => {
      cancelled = true;
    };
  }, [base, activeRepo, revision, reposReady]);

  // An open diff re-reads when the tree may have moved, so a file the agent is
  // editing keeps its diff current. The previous text stays on screen until
  // the re-read lands — blanking it to 读取中 on every burst would flicker.
  useEffect(() => {
    if (open === null || open.repo !== activeRepo) return;
    let cancelled = false;
    setSlots((current) => {
      const prior = current.get(open.path);
      if (prior?.state === "ready") return current;
      const next = new Map(current).set(open.path, { state: "loading" });
      return next;
    });
    void loadDiff(base, open.path, activeRepo || undefined).then((reply) => {
      if (cancelled) return;
      setSlots((current) => {
        const next = new Map(current);
        next.set(open.path, reply.ok ? { state: "ready", diff: reply.value } : { state: "error", code: reply.code });
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [base, open, activeRepo, revision]);

  const applyStage = useCallback(
    (req: { paths?: string[]; all?: boolean; unstage?: boolean }) => {
      if (readOnly || busy) return;
      setBusy(true);
      setStageError("");
      void stageChanges(base, { ...(activeRepo ? { repo: activeRepo } : {}), ...req }).then(
        (reply) => {
          setBusy(false);
          if (!reply.ok) {
            setStageError(reply.code);
            return;
          }
          refresh();
        },
      );
    },
    [base, activeRepo, readOnly, busy, refresh],
  );

  const onToggleFile = useCallback(
    (path: string, current: boolean | "mixed") => {
      applyStage(current === true ? { paths: [path], unstage: true } : { paths: [path] });
    },
    [applyStage],
  );
  const onToggleFolder = useCallback(
    (paths: string[], current: boolean | "mixed") => {
      applyStage(current === true ? { paths, unstage: true } : { paths });
    },
    [applyStage],
  );

  const onOpenDiff = useCallback(
    (path: string): void => {
      setOpen((current) =>
        current !== null && current.repo === activeRepo && current.path === path
          ? null
          : { repo: activeRepo, path },
      );
    },
    [activeRepo],
  );

  const onOpenFile = useCallback((path: string): void => {
    setTab("files");
    setJump({ path, token: Date.now() });
  }, []);

  const all = settledAll(changes ?? { repo: true, changes: [] });
  const isRepo = (changes?.repo ?? true) && (gitView?.repo ?? true);
  const tree = useMemo(() => buildTree(changes?.changes ?? []), [changes]);

  return (
    <div className="wb">
      <button type="button" className="wb-close" onClick={onClose}>
        ‹ 返回会话
      </button>
      <div className="wb-tabs" role="tablist" aria-label="工作台">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "changes"}
          className={tab === "changes" ? "on" : undefined}
          onClick={() => setTab("changes")}
        >
          变更
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "files"}
          className={tab === "files" ? "on" : undefined}
          onClick={() => setTab("files")}
        >
          文件
        </button>
      </div>

      {readOnly && <p className="wb-readonly">该会话只读：另一个程序持有写入租约。</p>}

      {tab === "changes" ? (
        <div className="wb-changes">
          {reposError && (
            <p className="wb-wait" role="alert">
              {`仓库列表没读出来（${reposError}），按工作区自己的仓库显示。`}
            </p>
          )}
          {repos !== null && repos.length > 1 && (
            <div className="wb-repos" role="tablist" aria-label="仓库">
              {repos.map((row) => (
                <button
                  key={row.dir}
                  type="button"
                  role="tab"
                  aria-selected={row.dir === activeRepo}
                  className={row.dir === activeRepo ? "on" : undefined}
                  onClick={() => setActiveRepo(row.dir)}
                >
                  {row.name}
                </button>
              ))}
            </div>
          )}

          {gitView !== null && gitView.repo && (
            <div className="wb-branch">
              {gitView.detached ? (
                <span className="wb-branch-name" title={`游离头 · ${gitView.branch}`}>
                  {`游离头 · ${gitView.branch.slice(0, 7)}`}
                </span>
              ) : (
                <span className="wb-branch-name">{gitView.branch || "（无分支）"}</span>
              )}
              <span className="wb-branch-counts">
                <i data-io="up">{`+${gitView.added}`}</i>
                <i data-io="down">{`−${gitView.removed}`}</i>
              </span>
            </div>
          )}
          {gitView !== null && !gitView.repo && (
            <p className="wb-wait">
              {gitView.absent === "refused"
                ? "Git 拒绝打开这个仓库。"
                : "Git 没有回应。"}
              {gitView.detail ? ` ${gitView.detail}` : ""}
            </p>
          )}

          {!isRepo && (
            <p className="wb-wait">这里不是 git 仓库，变更和历史都需要 git。</p>
          )}

          {isRepo && (
            <>
              {showCommit && (
                <CommitCard
                  base={base}
                  repo={activeRepo}
                  onClose={() => setShowCommit(false)}
                  // The card keeps its own done phase on screen; only the tree
                  // refreshes here.
                  onCommitted={() => refresh()}
                />
              )}
              <div className="wb-section-head">
                <span>
                  {changes === null
                    ? "变更"
                    : `${uniquePaths(changes)} 个文件`}
                </span>
                <span className="wb-section-actions">
                  {changes !== null && changes.repo && changes.changes.length > 0 && !readOnly && (
                    <button
                      type="button"
                      className="wb-more inline"
                      disabled={busy}
                      onClick={() => applyStage({ all: true, unstage: all })}
                    >
                      {all ? "全部取消暂存" : "全部暂存"}
                    </button>
                  )}
                  {changes !== null && changes.repo && !readOnly && (
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() => setShowCommit(true)}
                    >
                      提交…
                    </button>
                  )}
                </span>
              </div>
              {stageError && (
                <p className="wb-wait" role="alert">
                  {stageMessage(stageError)}
                </p>
              )}
              {changesError && (
                <>
                  <p className="wb-wait" role="alert">
                    {`没读出来：${changesError}`}
                  </p>
                  <button type="button" className="wb-more" onClick={() => refresh()}>
                    重新读取
                  </button>
                </>
              )}
              {changes === null && !changesError && <p className="wb-wait">读取中…</p>}
              {changes !== null && !changes.repo && (
                <p className="wb-wait">这里不是 git 仓库，变更和历史都需要 git。</p>
              )}
              {changes !== null && changes.repo && changes.changes.length === 0 && (
                <p className="wb-wait">没有变更。</p>
              )}
              {changes !== null && changes.repo && changes.changes.length > 0 && (
                <ChangesTree
                  nodes={tree}
                  busy={busy}
                  readOnly={readOnly}
                  openPath={openPath}
                  slots={slots}
                  onToggleFile={onToggleFile}
                  onToggleFolder={onToggleFolder}
                  onOpenDiff={onOpenDiff}
                  onOpenFile={onOpenFile}
                />
              )}
              <HistorySection
                key={activeRepo || "workspace"}
                base={base}
                repo={activeRepo}
                disabled={changes?.repo === false}
              />
            </>
          )}
        </div>
      ) : (
        <FileBrowser base={base} jump={jump} />
      )}
    </div>
  );
}
