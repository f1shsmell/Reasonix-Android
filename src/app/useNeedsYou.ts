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
import { loadStatus } from "../net/status";
import type { Decision } from "../net/status";
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
  status: "loading" | "loaded";
  /** Re-sweep without waiting for the tree to change. */
  refresh: () => void;
}

/** Every conversation a pane is driving, with the labels its row needs. */
export function paneCandidates(projects: TreeProject[]): Candidate[] {
  const out: Candidate[] = [];
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!session.runtimeId) continue;
      out.push({
        base: `/rt/${session.runtimeId}`,
        runtimeId: session.runtimeId,
        projectName: project.name,
        projectRoot: project.root,
        title: sessionTitle(session),
      });
    }
  }
  return out;
}

export function useNeedsYou(projects: TreeProject[], revision: number): NeedsYouState {
  const [items, setItems] = useState<PendingItem[]>([]);
  const [status, setStatus] = useState<"loading" | "loaded">("loading");
  const [tick, setTick] = useState(0);
  /** A slow sweep must not overwrite the answer of a newer one. */
  const request = useRef(0);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    const candidates = paneCandidates(projects);
    const at = ++request.current;
    if (candidates.length === 0) {
      // Nothing is open, so nothing can be blocked. Mark it loaded rather than
      // leaving the block spinning over an empty list.
      setItems([]);
      setStatus("loaded");
      return;
    }
    void Promise.all(
      candidates.map(async (candidate) => {
        const result = await loadStatus(candidate.base);
        if (!result.ok) return [];
        return result.status.decisions.map((decision) => ({
          base: candidate.base,
          runtimeId: candidate.runtimeId,
          projectName: candidate.projectName,
          projectRoot: candidate.projectRoot,
          title: candidate.title,
          decision,
        }));
      }),
    ).then((groups) => {
      if (at !== request.current) return;
      setItems(groups.flat());
      setStatus("loaded");
    });
    // `projects` is the array identity from useTree, which only changes on a
    // successful read; `revision` is what makes a re-read visible here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, tick]);

  return { items, status, refresh };
}
