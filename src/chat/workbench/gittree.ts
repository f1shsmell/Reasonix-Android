/**
 * The changes list as a folder tree — a verbatim port of the desktop's
 * `state/gittree.ts`, so the phone draws the list the workbench draws. Folders
 * come before files, each in name order, and a folder with exactly one folder
 * in it and nothing else is joined to it ("a/b/c" on one row), as an editor's
 * compact folders do. Pure: the same list gives the same tree.
 */

import type { Change, GitRepoRow } from "../../wire/changes";

/** A folder or a file in the changes tree. A folder carries what is under it, so a
 *  collapsed folder still says how much changed and whether it is staged. */
export type ChangeNode =
  | { kind: "file"; name: string; path: string; change: Change }
  | {
      kind: "folder";
      name: string;
      path: string;
      children: ChangeNode[];
      files: Change[];
      insertions: number;
      deletions: number;
    };

export function buildTree(changes: Change[]): ChangeNode[] {
  type Open = { name: string; path: string; folders: Map<string, Open>; files: Change[] };
  const root: Open = { name: "", path: "", folders: new Map(), files: [] };
  for (const change of changes) {
    const parts = change.path.split("/");
    let at = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const path = parts.slice(0, i + 1).join("/");
      let next = at.folders.get(parts[i] ?? "");
      if (!next) {
        next = { name: parts[i] ?? "", path, folders: new Map(), files: [] };
        at.folders.set(parts[i] ?? "", next);
      }
      at = next;
    }
    at.files.push(change);
  }
  const list = (open: Open): ChangeNode[] => [
    ...[...open.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map(close),
    ...[...open.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((entry): ChangeNode => ({
        kind: "file",
        name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
        path: entry.path,
        change: entry,
      })),
  ];
  const close = (open: Open): ChangeNode => {
    let node = open;
    let name = open.name;
    while (node.files.length === 0 && node.folders.size === 1) {
      const only = [...node.folders.values()][0];
      if (!only) break;
      node = only;
      name += `/${node.name}`;
    }
    const children = list(node);
    const files = children.flatMap((c) => (c.kind === "file" ? [c.change] : c.files));
    const sum = (pick: (c: Change) => number | undefined) =>
      files.reduce((n, c) => n + (pick(c) ?? 0), 0);
    return {
      kind: "folder",
      name,
      path: node.path,
      children,
      files,
      insertions: sum((c) => c.insertions),
      deletions: sum((c) => c.deletions),
    };
  };
  return list(root);
}

/**
 * Whether a set of changes is wholly staged, partly staged or not staged at
 * all: the state of a file's own checkbox, and of a folder's over the files
 * under it. A path that is staged and still differs from the index is mixed —
 * ticking it finishes staging it, never unstages.
 */
export function stagedState(changes: Change[]): boolean | "mixed" {
  if (changes.length === 0) return false;
  const staged = changes.filter((c) => c.staged).length;
  const whole = changes.filter((c) => c.staged && !c.unstaged).length;
  if (whole === changes.length) return true;
  return staged === 0 ? false : "mixed";
}

/**
 * Which repository a workspace-relative path belongs to, and the path within
 * it: the deepest listed folder that contains it. A workspace that is itself
 * the repository (one row, empty dir) owns every path.
 */
export function locate(repos: GitRepoRow[], path: string): { repo: string; rel: string } {
  let best = "";
  for (const row of repos) {
    if (row.dir && path.startsWith(`${row.dir}/`) && row.dir.length > best.length) best = row.dir;
  }
  return best ? { repo: best, rel: path.slice(best.length + 1) } : { repo: "", rel: path };
}
