/**
 * The project → conversation tree, read once per screen and re-read on demand.
 *
 * One read feeds both levels: the project list draws each project's counts, and
 * a project's conversation list draws the rows that read already carried. That
 * is why opening a project is instant — and why the same read is retried when
 * a project asks for a wider window ("show more").
 *
 * The read is not a subscription. The kernel's `GET /tree/events` stream exists
 * for the desktop sidebar; a phone that sat on it would spend the battery on a
 * list nobody is watching. Pull-to-refresh and the refresh button are the
 * contract here.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_TREE_LIMIT, loadTree } from "../net/tree";
import type { TreeProject } from "../wire/tree";

export interface TreeState {
  projects: TreeProject[];
  status: "loading" | "loaded" | "failed";
  /** Kernel or transport code behind a failed read; empty otherwise. */
  code: string;
  /**
   * Bumped after every successful read. A reader that derives something from
   * the tree (the pending-decision sweep, say) keys its own work on this, so a
   * refresh reaches it without the tree handing out its projects twice.
   */
  revision: number;
  /** Re-read, optionally widening one project's window. */
  reload: (limits?: Record<string, number>) => void;
}

export function useTree(limit = DEFAULT_TREE_LIMIT): TreeState {
  const [projects, setProjects] = useState<TreeProject[]>([]);
  const [status, setStatus] = useState<"loading" | "loaded" | "failed">("loading");
  const [code, setCode] = useState("");
  const [revision, setRevision] = useState(0);
  const [tick, setTick] = useState(0);
  const limits = useRef<Record<string, number>>({});
  /** A slow read must not overwrite the answer of a newer one. */
  const request = useRef(0);

  const reload = useCallback((next?: Record<string, number>) => {
    if (next) limits.current = { ...limits.current, ...next };
    setTick((value) => value + 1);
  }, []);

  useEffect(() => {
    const at = ++request.current;
    // Only the first read blanks the screen. A refresh keeps the rows it has:
    // an empty list mid-refresh reads as "your projects are gone".
    if (status !== "loaded") setStatus("loading");
    void loadTree({ limit, limits: limits.current }).then((result) => {
      if (at !== request.current) return;
      if (!result.ok) {
        setStatus("failed");
        setCode(result.code);
        return;
      }
      setProjects(result.projects);
      setStatus("loaded");
      setCode("");
      setRevision((value) => value + 1);
    });
    // `status` is read, not a trigger: a refresh loop is not wanted here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit, tick]);

  return { projects, status, code, revision, reload };
}
