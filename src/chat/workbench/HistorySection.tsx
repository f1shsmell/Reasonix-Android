import { useEffect, useRef, useState } from "react";
import { loadCommitDiff, loadCommitFiles, loadHistory } from "../../net/changes";
import type {
  ChangeDiff,
  Commit as GitCommit,
  CommitDetailFile,
  GitCommitFiles,
  GitHistory,
} from "../../wire/changes";
import { StudioIcon } from "../../app/StudioIcon";
import { WorkbenchDiff } from "./WorkbenchDiff";

/** A bare duration, the way the history rows print it: no "ago", no clock. */
function ageText(atSeconds: number, now: number): string {
  const delta = Math.max(0, now - atSeconds * 1000);
  if (delta < 60_000) return "刚刚";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

function refShort(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, "");
}

/**
 * The commit history, folded under the changes and read on every open — the
 * desktop's `WorkbenchHistory` minus the client-drawn graph lanes. A row
 * expands into its files and collapses again; a file expands into its diff.
 * `refreshToken` moves when a commit lands, so an open section re-reads instead
 * of showing a history the person's own commit already moved past.
 */
export function HistorySection({
  base,
  repo,
  disabled,
  refreshToken,
}: {
  base: string;
  repo: string;
  disabled?: boolean;
  refreshToken: number;
}) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<GitHistory | null>(null);
  const [error, setError] = useState("");
  /** An open section re-reads on a commit while its own open-read may still be
   *  in flight; the later request wins, not the later answer. */
  const readReq = useRef(0);

  const read = (): void => {
    const mine = ++readReq.current;
    setError("");
    void loadHistory(base, repo || undefined).then((reply) => {
      if (mine !== readReq.current) return;
      if (!reply.ok) {
        setError(reply.code);
        return;
      }
      setHistory(reply.value);
    });
  };

  useEffect(() => {
    if (open) read();
    // base/repo remount the section through its key; the token is the commit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, refreshToken]);

  if (disabled) return null;
  return (
    <section className="wb-history">
      <button
        type="button"
        className="wb-history-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <StudioIcon name="down" className={open ? "wb-chevron open" : "wb-chevron"} />
        提交历史
      </button>
      {open && (
        <div className="wb-history-body">
          {history === null && !error && <p className="wb-wait">读取中…</p>}
          {error && (
            <>
              <p className="wb-wait">{`没读出来：${error}`}</p>
              <button type="button" className="wb-more" onClick={read}>
                重新读取
              </button>
            </>
          )}
          {history !== null && !history.repo && <p className="wb-wait">这个文件夹不是 git 仓库，变更和历史都需要 git。</p>}
          {history !== null && history.repo && history.commits.length === 0 && (
            <p className="wb-wait">还没有提交。</p>
          )}
          {history?.commits.map((commit) => (
            <CommitRow key={commit.id} base={base} repo={repo} commit={commit} now={Date.now()} />
          ))}
          {history?.truncated === true && <p className="wb-wait">只显示了最近的提交。</p>}
        </div>
      )}
    </section>
  );
}

function CommitRow({
  base,
  repo,
  commit,
  now,
}: {
  base: string;
  repo: string;
  commit: GitCommit;
  now: number;
}) {
  const [files, setFiles] = useState<GitCommitFiles | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<ChangeDiff | null>(null);
  const [diffError, setDiffError] = useState("");
  /** The file whose diff request is in flight: a slow older answer must not
   *  overwrite the row the person tapped last. */
  const diffReq = useRef(0);
  /** Same guard for the files read, so a retry supersedes a slow refusal. */
  const filesReq = useRef(0);
  const refs = commit.refs.map(refShort).join(" · ");

  const expand = (): void => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (files !== null) return;
    load();
  };

  /** A refused read names its own fix: retry in place, not a remount. */
  const retry = (): void => {
    setError("");
    setFiles(null);
    load();
  };

  const load = (): void => {
    const mine = ++filesReq.current;
    void loadCommitFiles(base, commit.id, repo || undefined).then((reply) => {
      if (mine !== filesReq.current) return;
      if (!reply.ok) {
        setError(reply.code);
        return;
      }
      setFiles(reply.value);
    });
  };

  const openDiff = (path: string): void => {
    if (openFile === path) {
      setOpenFile(null);
      return;
    }
    const mine = ++diffReq.current;
    setOpenFile(path);
    setDiff(null);
    setDiffError("");
    void loadCommitDiff(base, commit.id, path, repo || undefined).then((reply) => {
      if (mine !== diffReq.current) return;
      if (!reply.ok) {
        setDiffError(reply.code);
        return;
      }
      setDiff(reply.value);
    });
  };

  return (
    <div className="wb-history-row">
      <button
        type="button"
        className="wb-row-main"
        aria-expanded={expanded}
        onClick={expand}
      >
        <span className="wb-row-name">
          <StudioIcon name="down" className={expanded ? "wb-chevron open" : "wb-chevron"} />
          <code className="wb-hash">{commit.id.slice(0, 7)}</code>
          <span className="wb-row-text">{commit.subject}</span>
        </span>
        <span className="wb-row-meta">
          {refs && <span className="wb-refs">{refs}</span>}
          <span className="wb-age">{ageText(commit.at, now)}</span>
        </span>
      </button>
      {error && (
        <>
          <p className="wb-wait">{`没读出来：${error}`}</p>
          <button type="button" className="wb-more" onClick={retry}>
            重新读取
          </button>
        </>
      )}
      {expanded && files === null && !error && <p className="wb-wait">读取中…</p>}
      {expanded && files !== null && (
        <div className="wb-history-files">
          {!files.repo && <p className="wb-wait">这个文件夹不是 git 仓库。</p>}
          {files.repo && files.files.length === 0 && <p className="wb-wait">这个提交没有文件变化。</p>}
          {files.files.map((file: CommitDetailFile) => (
            <div key={file.path} className="wb-row" data-node="file" style={{ paddingLeft: 14 }}>
              <button
                type="button"
                className="wb-row-main"
                aria-current={openFile === file.path ? "page" : undefined}
                onClick={() => openDiff(file.path)}
              >
                <span className="wb-row-name">
                  <em data-status="warn">{file.status}</em>
                  {file.path}
                  {file.oldPath && <span className="wb-oldpath">{` ← ${file.oldPath}`}</span>}
                </span>
                <span className="wb-row-meta" />
              </button>
              {openFile === file.path && (
                <div className="wb-row-diff">
                  {diffError && <p className="wb-wait">{`没读出来：${diffError}`}</p>}
                  {diff === null && !diffError && <p className="wb-wait">读取中…</p>}
                  {diff !== null && diff.diff === "" && <p className="wb-wait">没有可显示的文本变化。</p>}
                  {diff !== null && diff.diff !== "" && (
                    <WorkbenchDiff
                      diff={diff.diff}
                      truncated={diff.truncated === true}
                      label={file.path}
                    />
                  )}
                </div>
              )}
            </div>
          ))}
          {files.truncated === true && <p className="wb-wait">只显示了前面的文件。</p>}
        </div>
      )}
    </div>
  );
}
