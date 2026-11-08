/**
 * The git changes and workspace file contract, mirrored from the kernel:
 *
 * - `Change` ← `gitstatus.Change` (`internal/platform/gitstatus/gitstatus.go`)
 * - `Commit` ← `gitstatus.Commit` (`internal/platform/gitstatus/history.go`)
 * - `WorkspaceGitView` ← `serve.workspaceGitView` (`internal/frontend/serve/changes.go`)
 * - `CommitProposal` / `CommitRequest` ← `control` (`internal/session/control/commit.go`)
 * - `CommitFile` ← `gitcommit.File` (`internal/platform/gitcommit/gitcommit.go`)
 *
 * Every field is optional except those named: the kernel omits empty values,
 * so a missing field and an empty one mean the same thing. Unknown fields are
 * ignored — the phone and the desktop update on different schedules, and the
 * contract only grows. The parity gate (`scripts/check-wire.mjs`) holds the
 * named-struct fields to the kernel's Go tags; the answers that are anonymous
 * Go structs (`/changes`, `/changes/diff`, `/git/repos`, `/workspace/file`) are
 * parsed defensively here instead.
 */

/** One path git reports as differing from HEAD. */
export interface Change {
  path: string;
  /** Renames carry the former path. */
  oldPath?: string;
  /** Git porcelain XY trimmed: "M" | "A" | "D" | "R" | "??". */
  status: string;
  /** The index differs from HEAD for this path. */
  staged?: boolean;
  /** The work tree differs from the index, or the path is untracked. */
  unstaged?: boolean;
  /**
   * How much the file differs by. Absent means git did not count it — a
   * binary file, or one nothing counted. Absent is a different fact from
   * zero and is drawn differently.
   */
  insertions?: number;
  deletions?: number;
}

/** `GET /changes`: the working tree's answer. `repo:false` is not a git repository. */
export interface WorkspaceChanges {
  repo: boolean;
  changes: Change[];
}

/** `GET /changes/diff`: one path's unified working-tree diff. */
export interface ChangeDiff {
  path: string;
  diff: string;
  truncated?: boolean;
}

/** `GET /workspace/git`: the work tree's one-line git identity. */
export interface WorkspaceGitView {
  repo: boolean;
  name: string;
  branch: string;
  detached: boolean;
  added: number;
  removed: number;
  untracked: number;
  /**
   * Why a marked folder has no repository: "refused" (git said no) or
   * "unavailable" (git did not answer); `detail` is what git printed.
   */
  absent?: string;
  detail?: string;
}

/** One repository below the workspace; `dir:""` is the workspace's own. */
export interface GitRepoRow {
  dir: string;
  name: string;
  branch: string;
  detached?: boolean;
}

/** `GET /git/repos`: the repositories of the workspace. */
export interface GitReposView {
  repos: GitRepoRow[];
  truncated?: boolean;
}

/** One staged file, as the commit proposal carries it. */
export interface CommitFile {
  path: string;
  status: string;
  insertions?: number;
  deletions?: number;
  /** The kernel's name-based secret marker. */
  sensitive?: boolean;
}

/** `POST /commit/propose`: the staged set and the model's proposed message. */
export interface CommitProposal {
  message: string;
  /** Names the staged set; `POST /commit` refuses an index that has moved on. */
  fingerprint: string;
  files: CommitFile[];
  truncated?: boolean;
  /** Added lines contain values shaped like credentials. */
  contentSecrets?: boolean;
  /**
   * Why `message` is empty when the model could not draft one:
   * `no_model` | `timeout` | `no_answer` | `model_failed`. The staged set is
   * still real; the person writes the message themselves.
   */
  draftFailure?: string;
}

/** The body of `POST /commit`. */
export interface CommitRequest {
  repo?: string;
  message: string;
  fingerprint: string;
  acknowledgeSecrets?: boolean;
}

/** The commit that was recorded. */
export interface CommitResult {
  hash: string;
  subject: string;
}

/** One commit of the repository's history. `at` is unix seconds. */
export interface Commit {
  id: string;
  parents: string[];
  author: string;
  at: number;
  refs: string[];
  subject: string;
}

/** `GET /workspace/git/log`: the newest commits, newest first. */
export interface GitHistory {
  repo: boolean;
  commits: Commit[];
  truncated?: boolean;
}

/** One file of a recorded commit. */
export interface CommitDetailFile {
  path: string;
  oldPath?: string;
  status: string;
  insertions?: number;
  deletions?: number;
}

/** `GET /git/commit`: one commit's files. */
export interface GitCommitFiles {
  repo: boolean;
  files: CommitDetailFile[];
  truncated?: boolean;
}

/** `GET /workspace/file`: one file's text content, sha256-revised. */
export interface WorkspaceFile {
  path: string;
  content: string;
  revision: string;
  /** The granted folder the file was read from; empty for the workspace. */
  root?: string;
  /** A granted-folder file cannot be written through this route. */
  readOnly?: boolean;
}

/** `GET /workspace/files`: one folder's names, or the paths a search matched. */
export interface WorkspaceListing {
  files: string[];
  directories: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const bool = (value: unknown): boolean | undefined => (value === true ? true : undefined);

/** A counted line delta, or nothing when git did not count the file. */
const count = (value: unknown): number | undefined => {
  const parsed = num(value);
  return parsed === undefined ? undefined : parsed;
};

function change(value: unknown): Change | null {
  if (!isRecord(value)) return null;
  const path = str(value.path);
  if (!path) return null;
  const out: Change = { path, status: str(value.status) };
  const oldPath = str(value.oldPath);
  if (oldPath) out.oldPath = oldPath;
  const staged = bool(value.staged);
  if (staged) out.staged = staged;
  const unstaged = bool(value.unstaged);
  if (unstaged) out.unstaged = unstaged;
  const insertions = count(value.insertions);
  if (insertions !== undefined) out.insertions = insertions;
  const deletions = count(value.deletions);
  if (deletions !== undefined) out.deletions = deletions;
  return out;
}

/** The `/changes` answer as the app reads it, validated. */
export function parseWorkspaceChanges(value: unknown): WorkspaceChanges {
  const row = isRecord(value) ? value : {};
  const raw = Array.isArray(row.changes) ? row.changes : [];
  return {
    repo: row.repo === true,
    changes: raw.map(change).filter((entry): entry is Change => entry !== null),
  };
}

/** The `/changes/diff` answer, validated. */
export function parseChangeDiff(value: unknown, fallbackPath: string): ChangeDiff {
  const row = isRecord(value) ? value : {};
  const truncated = bool(row.truncated);
  return {
    path: str(row.path) || fallbackPath,
    diff: str(row.diff),
    ...(truncated ? { truncated } : {}),
  };
}

/** The `/workspace/git` answer, validated. */
export function parseWorkspaceGit(value: unknown): WorkspaceGitView {
  const row = isRecord(value) ? value : {};
  const absent = str(row.absent);
  const detail = str(row.detail);
  return {
    repo: row.repo === true,
    name: str(row.name),
    branch: str(row.branch),
    detached: row.detached === true,
    added: num(row.added) ?? 0,
    removed: num(row.removed) ?? 0,
    untracked: num(row.untracked) ?? 0,
    ...(absent ? { absent } : {}),
    ...(detail ? { detail } : {}),
  };
}

function repoRow(value: unknown): GitRepoRow | null {
  if (!isRecord(value)) return null;
  // A repo whose identity read failed still carries its dir — the kernel fills
  // the row regardless (serve/changes.go: `info, _ := gitstatus.Identity`),
  // and dropping it would hide a real repository from the switcher.
  const dir = str(value.dir);
  const name = str(value.name);
  if (!dir && !name) return null;
  const out: GitRepoRow = { dir, name, branch: str(value.branch) };
  const detached = bool(value.detached);
  if (detached) out.detached = detached;
  return out;
}

/** The `/git/repos` answer, validated. */
export function parseGitRepos(value: unknown): GitReposView {
  const row = isRecord(value) ? value : {};
  const raw = Array.isArray(row.repos) ? row.repos : [];
  const repos = raw.map(repoRow).filter((entry): entry is GitRepoRow => entry !== null);
  const truncated = bool(row.truncated);
  return { repos, ...(truncated ? { truncated } : {}) };
}

function commitFile(value: unknown): CommitFile | null {
  const row = change(value);
  if (row === null) return null;
  const sensitive = bool((value as Record<string, unknown>).sensitive);
  return {
    path: row.path,
    status: row.status,
    ...(row.insertions !== undefined ? { insertions: row.insertions } : {}),
    ...(row.deletions !== undefined ? { deletions: row.deletions } : {}),
    ...(sensitive ? { sensitive } : {}),
  };
}

/** The `/commit/propose` answer, validated. */
export function parseCommitProposal(value: unknown): CommitProposal {
  const row = isRecord(value) ? value : {};
  const raw = Array.isArray(row.files) ? row.files : [];
  const draftFailure = str(row.draftFailure);
  const truncated = bool(row.truncated);
  const contentSecrets = bool(row.contentSecrets);
  return {
    message: str(row.message),
    fingerprint: str(row.fingerprint),
    files: raw.map(commitFile).filter((entry): entry is CommitFile => entry !== null),
    ...(truncated ? { truncated } : {}),
    ...(contentSecrets ? { contentSecrets } : {}),
    ...(draftFailure ? { draftFailure } : {}),
  };
}

function commit(value: unknown): Commit | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  if (!id) return null;
  // The subject may be empty: `git commit --allow-empty-message` is legal, and
  // dropping the row would hide a commit the desktop still shows.
  const subject = str(value.subject);
  const parents = Array.isArray(value.parents)
    ? value.parents.filter((entry): entry is string => typeof entry === "string")
    : [];
  const refs = Array.isArray(value.refs)
    ? value.refs.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    id,
    parents,
    author: str(value.author),
    at: num(value.at) ?? 0,
    refs,
    subject,
  };
}

/** The `/workspace/git/log` answer, validated. */
export function parseGitHistory(value: unknown): GitHistory {
  const row = isRecord(value) ? value : {};
  const raw = Array.isArray(row.commits) ? row.commits : [];
  const truncated = bool(row.truncated);
  return {
    repo: row.repo === true,
    commits: raw.map(commit).filter((entry): entry is Commit => entry !== null),
    ...(truncated ? { truncated } : {}),
  };
}

function detailFile(value: unknown): CommitDetailFile | null {
  const row = change(value);
  if (row === null) return null;
  return {
    path: row.path,
    ...(row.oldPath !== undefined ? { oldPath: row.oldPath } : {}),
    status: row.status,
    ...(row.insertions !== undefined ? { insertions: row.insertions } : {}),
    ...(row.deletions !== undefined ? { deletions: row.deletions } : {}),
  };
}

/** The `/git/commit` answer, validated. */
export function parseGitCommitFiles(value: unknown): GitCommitFiles {
  const row = isRecord(value) ? value : {};
  const raw = Array.isArray(row.files) ? row.files : [];
  const truncated = bool(row.truncated);
  return {
    repo: row.repo === true,
    files: raw.map(detailFile).filter((entry): entry is CommitDetailFile => entry !== null),
    ...(truncated ? { truncated } : {}),
  };
}

/** The `/workspace/file` answer, validated. */
export function parseWorkspaceFile(value: unknown, fallbackPath: string): WorkspaceFile {
  const row = isRecord(value) ? value : {};
  const root = str(row.root);
  const readOnly = bool(row.readOnly);
  return {
    path: str(row.path) || fallbackPath,
    content: str(row.content),
    revision: str(row.revision),
    ...(root ? { root } : {}),
    ...(readOnly ? { readOnly } : {}),
  };
}

const names = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** The `/workspace/files` answer, validated. */
export function parseWorkspaceListing(value: unknown): WorkspaceListing {
  const row = isRecord(value) ? value : {};
  return { files: names(row.files), directories: names(row.directories) };
}

/** The `POST /commit` answer, validated. */
export function parseCommitResult(value: unknown): CommitResult {
  const row = isRecord(value) ? value : {};
  return { hash: str(row.hash), subject: str(row.subject) };
}
