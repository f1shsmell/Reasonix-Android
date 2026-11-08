import { useEffect, useRef, useState } from "react";
import { commitMessage, commitStaged, draftFailureText, proposeCommit } from "../../net/changes";
import type { CommitFile, CommitProposal, CommitResult } from "../../wire/changes";

type Phase = "drafting" | "ready" | "failed" | "done";

/** The path as the commit card draws it: the directory side ellipsizes so the
 *  file's own name stays visible on a narrow row. */
function fileParts(path: string): { dir: string; base: string } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { dir: "", base: path } : { dir: path.slice(0, at + 1), base: path.slice(at + 1) };
}

/**
 * The commit as a proposal, never an action: the model drafts from the staged
 * diff, the person edits, and the confirm carries a fingerprint the kernel
 * verifies against an index that has not moved. A port of the desktop's
 * `CommitCard`; the card lives in-flow, never as a modal.
 */
export function CommitCard({
  base,
  repo,
  onClose,
  onCommitted,
}: {
  base: string;
  repo: string;
  onClose: () => void;
  onCommitted: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("drafting");
  const [proposal, setProposal] = useState<CommitProposal | null>(null);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<CommitResult | null>(null);
  const [error, setError] = useState("");
  const [acking, setAcking] = useState(false);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Stale-draft suppression by generation alone: a superseded draft's resolve
  // (including its abort) must not touch the state a newer draft owns. No
  // `alive` ref here — StrictMode's simulated remount would permanently disarm
  // it, and the unmount abort below is what actually stops the network.
  const draftId = useRef(0);
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const draft = (): void => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const mine = ++draftId.current;
    setPhase("drafting");
    setProposal(null);
    setError("");
    void proposeCommit(base, repo || undefined, controller.signal).then((reply) => {
      if (mine !== draftId.current) return;
      if (!reply.ok) {
        // A draft that never came back says nothing about the staged set —
        // claiming "nothing staged" would be a guess. The failed phase offers
        // the redraft; the kernel's own draftFailure notes (which do carry the
        // staged list) arrive as successes and stay in the ready phase.
        setError(
          reply.code === "client.offline" || reply.code === "client.timeout"
            ? commitMessage(reply.code)
            : `没读出来：${reply.code}`,
        );
        setPhase("failed");
        return;
      }
      setProposal(reply.value);
      setMessage(reply.value.message);
      setPhase("ready");
    });
  };

  useEffect(() => {
    draft();
    // The card drafts once on open; redrafts are the button's job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, repo]);

  const needsAck =
    proposal !== null &&
    (proposal.contentSecrets === true || proposal.files.some((file) => file.sensitive === true));

  const commit = (): void => {
    if (!proposal || busy) return;
    setBusy(true);
    setError("");
    void commitStaged(base, {
      // `repo`/`acknowledgeSecrets` are optional: under exactOptionalPropertyTypes
      // the absent spelling is a conditional spread, never an explicit undefined.
      ...(repo ? { repo } : {}),
      message: message,
      fingerprint: proposal.fingerprint,
      ...(needsAck ? { acknowledgeSecrets: acking } : {}),
    }).then((reply) => {
      setBusy(false);
      if (!reply.ok) {
        setError(commitMessage(reply.code));
        return;
      }
      setResult(reply.value);
      setPhase("done");
      onCommitted();
    });
  };

  if (phase === "done" && result !== null) {
    return (
      <section className="wb-commit" role="status">
        <p className="wb-commit-done">{`已提交 ${result.hash.slice(0, 7)}：${result.subject}`}</p>
        <button type="button" className="wb-commit-cancel" onClick={onClose}>
          关闭
        </button>
      </section>
    );
  }

  if (phase === "drafting") {
    return (
      <section className="wb-commit" aria-busy="true">
        <div className="wb-commit-head">
          <h3>提交</h3>
          <button type="button" className="wb-commit-cancel" onClick={onClose}>
            取消
          </button>
        </div>
        <p className="wb-wait">正在阅读暂存的变更并起草提交信息…</p>
      </section>
    );
  }

  if (phase === "failed") {
    return (
      <section className="wb-commit">
        <div className="wb-commit-head">
          <h3>提交</h3>
          <button type="button" className="wb-commit-cancel" onClick={onClose}>
            取消
          </button>
        </div>
        <p className="wb-commit-error" role="alert">
          {error}
        </p>
        <div className="wb-commit-actions">
          <button type="button" onClick={draft}>
            重新起草
          </button>
        </div>
      </section>
    );
  }

  const staged = proposal?.files ?? [];
  const truncated = proposal?.truncated === true;
  const draftFailure = proposal?.draftFailure;
  return (
    <section className="wb-commit">
      <div className="wb-commit-head">
        <h3>{`暂存文件 · ${staged.length} 个已暂存`}</h3>
        <button type="button" className="wb-commit-cancel" onClick={onClose}>
          取消
        </button>
      </div>
      {draftFailure && proposal !== null && staged.length > 0 && (
        <p className="wb-commit-note">{draftFailureText(draftFailure)}</p>
      )}
      {truncated && <p className="wb-commit-note">暂存的 diff 很长，草案只读了开头的一部分。</p>}
      {staged.length > 0 ? (
        <ul className="wb-commit-files">
          {staged.map((file: CommitFile) => {
            const parts = fileParts(file.path);
            return (
              <li key={file.path}>
                <em data-status={file.status}>{file.status}</em>
                <span className="wb-commit-path">
                  <span className="wb-commit-dir">{parts.dir}</span>
                  <span>{parts.base}</span>
                </span>
                {file.sensitive === true && <span className="wb-sensitive">疑似密钥</span>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="wb-commit-note">没有已暂存的变更，先在列表里勾选。</p>
      )}
      {needsAck && (
        <label className="wb-ack">
          <input
            type="checkbox"
            checked={acking}
            onChange={(event) => setAcking(event.target.checked)}
          />
          我确认这些可以提交
        </label>
      )}
      <textarea
        className="wb-commit-message"
        rows={6}
        value={message}
        placeholder="提交信息…"
        onChange={(event) => setMessage(event.target.value)}
      />
      {error && (
        <p className="wb-commit-error" role="alert">
          {error}
        </p>
      )}
      <div className="wb-commit-actions">
        <button
          type="button"
          className="wb-commit-go"
          disabled={busy || !message.trim() || (needsAck && !acking) || staged.length === 0}
          onClick={commit}
        >
          本地提交
        </button>
        <button type="button" disabled={busy} onClick={draft}>
          重新起草
        </button>
      </div>
      <p className="wb-commit-note">仅本地提交，不会推送。</p>
    </section>
  );
}
