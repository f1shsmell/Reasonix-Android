/**
 * Going back to the snapshot the kernel took before a turn.
 *
 * Two steps on purpose: the first asks what the kernel would do, the second
 * commits the plan it named. The phone never edits conversation or files on
 * its own, and a plan the kernel cannot cover says so before the tap that
 * would apply it.
 */

import { useCallback, useEffect, useState } from "react";
import { commitRewind, loadCheckpoints, prepareRewind, rewindMessage } from "../net/rewind";
import type { Checkpoint, RewindPlan } from "../net/rewind";
import { useBackCloser } from "../app/backStack";

function coverage(plan: RewindPlan): string {
  if (!plan.canFiles && !plan.canConversation) return plan.disabledReason ?? "这个检查点无法恢复";
  if (plan.canFiles && plan.canConversation) return "恢复文件并截断对话";
  if (plan.canFiles) return "只恢复文件；这段对话无法截断";
  return "只截断对话；文件不在快照里";
}

export function CheckpointsSheet({
  base,
  onClose,
  onRewound,
}: {
  base: string;
  onClose: () => void;
  onRewound: () => void;
}) {
  const [list, setList] = useState<Checkpoint[] | null>(null);
  const [plan, setPlan] = useState<RewindPlan | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useBackCloser(true, onClose);

  useEffect(() => {
    let cancelled = false;
    void loadCheckpoints(base).then((next) => {
      if (!cancelled) setList(next);
    });
    return () => {
      cancelled = true;
    };
  }, [base]);

  const choose = useCallback(
    async (checkpoint: Checkpoint) => {
      setBusy("prepare");
      setError("");
      const result = await prepareRewind(base, checkpoint.turn);
      setBusy("");
      if (!result.ok) {
        setError(rewindMessage(result.code));
        return;
      }
      setPlan(result.value);
    },
    [base],
  );

  const confirm = useCallback(async () => {
    if (!plan || busy) return;
    setBusy("commit");
    setError("");
    const result = await commitRewind(base, plan.planId);
    setBusy("");
    if (!result.ok) {
      setError(rewindMessage(result.code));
      return;
    }
    if (result.value.ok === false) {
      setError(result.value.error ?? "内核没有完成这次回退。");
      return;
    }
    onRewound();
    onClose();
  }, [base, busy, onClose, onRewound, plan]);

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        className="sheet checkpoints-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="检查点"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>检查点</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <p className="sheet-note">
          内核在每一轮第一次写入前拍下快照。只能恢复编辑工具改过的文件；命令行的副作用不在其中。
        </p>

        {list === null ? <p className="sheet-note">正在读取检查点…</p> : null}
        {list !== null && list.length === 0 ? (
          <p className="sheet-note">还没有可以回去的检查点。</p>
        ) : null}

        {list !== null && list.length > 0 && plan === null ? (
          <ul className="sheet-actions checkpoint-list">
            {list.map((checkpoint) => (
              <li key={`${checkpoint.turn}:${checkpoint.prompt}`}>
                <button
                  type="button"
                  disabled={busy !== ""}
                  onClick={() => void choose(checkpoint)}
                >
                  <span>第 {checkpoint.turn} 轮</span>
                  <small>
                    {checkpoint.prompt || "（没有输入）"} · {checkpoint.files} 个文件
                  </small>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {plan ? (
          <div className="rewind-plan">
            <strong>回到第 {plan.turn} 轮之前</strong>
            <p>{coverage(plan)}</p>
            <p>
              {plan.fileCount} 个文件
              {plan.requiresConfirmation ? " · 这一轮还有快照之外的改动，确认后仍按快照恢复" : ""}
            </p>
            {plan.coverageGaps && plan.coverageGaps.length > 0 ? (
              <p className="rewind-gap">
                未覆盖：{plan.coverageGaps[0]?.detail}
                {plan.coverageGaps.length > 1 ? ` 等 ${plan.coverageGaps.length} 项` : ""}
              </p>
            ) : null}
            <div className="rewind-actions">
              <button type="button" className="chip" onClick={() => setPlan(null)} disabled={busy !== ""}>
                取消
              </button>
              <button
                type="button"
                className="chip accent"
                disabled={busy !== "" || (!plan.canFiles && !plan.canConversation)}
                onClick={() => void confirm()}
              >
                {busy === "commit" ? "正在恢复…" : "确认回到这里"}
              </button>
            </div>
          </div>
        ) : null}

        {error ? <div className="notice error">{error}</div> : null}
      </section>
    </div>
  );
}
