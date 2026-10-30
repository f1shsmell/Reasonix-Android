/**
 * What is waiting on the person, across every open conversation.
 *
 * A decision is a prompt blocking a turn: a tool approval, a plan approval, a
 * recovery choice, or a question. It lives in the controller of a running
 * pane — the kernel derives it from the owning subsystem on every read — so
 * there is nothing to aggregate server-side and nothing to store here. This
 * reads `GET /rt/{id}/status` for each conversation that has a pane and keeps
 * the ones with decisions.
 *
 * Only panes are swept, and that is the honest limit: a conversation the
 * desktop has open is one the kernel is actively blocking, while a transcript
 * with no pane cannot be waiting for anything. The cost is that a phone cannot
 * see a prompt raised in a session nobody has open — which is also the case on
 * the desktop.
 *
 * One pane failing to answer is dropped, not reported: a phone that could not
 * reach one runtime must not claim the person has nothing to do.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Attention, decisionKey, runningKey } from "./attention";
import { loadStatus } from "../net/status";
import type { Decision } from "../net/status";
import type { RuntimeView } from "../wire/runtime";
import type { TreeProject } from "../wire/tree";
import { sessionTitle } from "./SessionList";

export interface PendingItem {
  /** The pane's request prefix, for the screen that opens it. */
  base: string;
  runtimeId: string;
  projectName: string;
  projectRoot: string;
  title: string;
  decision: Decision;
  /** When this decision first appeared to the phone. */
  firstSeenAt: number;
  /** The person has not opened this card since it appeared. */
  isNew: boolean;
}

/** A pane whose turn is still working, with no decision blocking it. */
export interface RunningItem {
  base: string;
  runtimeId: string;
  projectName: string;
  projectRoot: string;
  title: string;
  /** When this turn was first seen running. */
  firstSeenAt: number;
}

interface Candidate {
  base: string;
  runtimeId: string;
  projectName: string;
  projectRoot: string;
  title: string;
}

export interface NeedsYouState {
  items: PendingItem[];
  /** Turns still working, so home can show what is happening right now. */
  running: RunningItem[];
  status: "loading" | "loaded";
  /** Re-sweep without waiting for the tree to change. */
  refresh: () => void;
  /** The card was opened; its new badge is done. */
  markSeen: (item: PendingItem) => void;
}

/**
 * Every open pane, with the labels its row needs.
 *
 * `/runtimes` is the authoritative list: a pane can be blocked even when its
 * project or session is beyond the tree's limited read. The tree only supplies
 * a nicer title and project name when it happens to know the pane.
 */
export function paneCandidates(runtimes: RuntimeView[], projects: TreeProject[]): Candidate[] {
  const labels = new Map<string, { projectName: string; title: string }>();
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!session.runtimeId) continue;
      labels.set(session.runtimeId, {
        projectName: project.name,
        title: sessionTitle(session),
      });
    }
  }
  const out: Candidate[] = [];
  for (const runtime of runtimes) {
    const label = labels.get(runtime.id);
    out.push({
      base: runtime.base || `/rt/${runtime.id}`,
      runtimeId: runtime.id,
      projectName: label?.projectName ?? (runtime.name || runtime.root),
      projectRoot: runtime.root,
      title: label?.title ?? runtimeTitle(runtime),
    });
  }
  return out;
}

/** The transcript's file name, or the project name before a path exists. */
function runtimeTitle(runtime: RuntimeView): string {
  const path = (runtime.sessionPath ?? "").trim();
  const base = path.split(/[\\/]/).pop() ?? "";
  return base || runtime.name;
}

export function useNeedsYou(
  runtimes: RuntimeView[],
  projects: TreeProject[],
  revision: number,
): NeedsYouState {
  const [items, setItems] = useState<PendingItem[]>([]);
  const [running, setRunning] = useState<RunningItem[]>([]);
  const [status, setStatus] = useState<"loading" | "loaded">("loading");
  const [tick, setTick] = useState(0);
  /** A slow sweep must not overwrite the answer of a newer one. */
  const request = useRef(0);
  /** First sighting and read state survive polls and app restarts. */
  const attention = useRef<Attention | null>(null);
  attention.current ??= new Attention();

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    const candidates = paneCandidates(runtimes, projects);
    const at = ++request.current;
    if (candidates.length === 0) {
      // Nothing is open, so nothing can be blocked. Mark it loaded rather than
      // leaving the block spinning over an empty list.
      setItems([]);
      setRunning([]);
      setStatus("loaded");
      return;
    }
    void Promise.all(
      candidates.map(async (candidate) => {
        const result = await loadStatus(candidate.base);
        if (!result.ok) return { pending: [], running: null };
        const now = Date.now();
        return {
          pending: result.status.decisions.map((decision) => {
            const view = attention.current?.decision(
              decisionKey(candidate.runtimeId, decision.id),
              now,
            );
            return {
              base: candidate.base,
              runtimeId: candidate.runtimeId,
              projectName: candidate.projectName,
              projectRoot: candidate.projectRoot,
              title: candidate.title,
              decision,
              firstSeenAt: view?.firstSeenAt ?? now,
              isNew: view?.isNew ?? false,
            };
          }),
          running: result.status.running
            ? {
                base: candidate.base,
                runtimeId: candidate.runtimeId,
                projectName: candidate.projectName,
                projectRoot: candidate.projectRoot,
                title: candidate.title,
                firstSeenAt:
                  attention.current?.running(runningKey(candidate.runtimeId), now) ?? now,
              }
            : null,
        };
      }),
    ).then((groups) => {
      if (at !== request.current) return;
      setItems(groups.flatMap((group) => group.pending));
      setRunning(
        groups.flatMap((group) => (group.running === null ? [] : [group.running])),
      );
      setStatus("loaded");
    });
    // `runtimes` is the connection's pane snapshot; `revision` is what makes a
    // tree reload visible to the labels. Both can change without the other.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimes, revision, tick]);

  // Home is the screen a person leaves open while work happens. Without a
  // clock the block only refreshed when the tree changed, which can be hours.
  useEffect(() => {
    const tickNow = () => {
      if (document.visibilityState === "visible") setTick((value) => value + 1);
    };
    const timer = window.setInterval(tickNow, 20_000);
    document.addEventListener("visibilitychange", tickNow);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tickNow);
    };
  }, []);

  const markSeen = useCallback((item: PendingItem) => {
    attention.current?.markSeen(decisionKey(item.runtimeId, item.decision.id));
    setItems((current) =>
      current.map((entry) =>
        entry.runtimeId === item.runtimeId && entry.decision.id === item.decision.id
          ? { ...entry, isNew: false }
          : entry,
      ),
    );
  }, []);

  return { items, running, status, refresh, markSeen };
}
