/**
 * The workbench's git reads and writes, addressed to one pane's prefix.
 *
 * Every route here is the kernel's own table mounted under `/rt/{id}/`, the
 * same prefix the composer and the transcript ride. Reading is allowed to fail
 * without failing the screen — a conversation with a working stream and no git
 * answer is better than no screen — so every loader returns a result union and
 * the caller decides what a refusal draws. The one intentional absence is
 * `POST /changes/discard`: the kernel refuses it for a paired device, so the
 * phone never sends it (see KNOWN_LIMITATIONS).
 */

import {
  parseChangeDiff,
  parseCommitProposal,
  parseCommitResult,
  parseGitCommitFiles,
  parseGitHistory,
  parseGitRepos,
  parseWorkspaceChanges,
  parseWorkspaceFile,
  parseWorkspaceGit,
  parseWorkspaceListing,
} from "../wire/changes";
import type {
  ChangeDiff,
  CommitProposal,
  CommitRequest,
  CommitResult,
  GitCommitFiles,
  GitHistory,
  GitReposView,
  WorkspaceChanges,
  WorkspaceFile,
  WorkspaceGitView,
  WorkspaceListing,
} from "../wire/changes";
import { RequestTimeout, fetchWithTimeout } from "./http";

export type ChangesReply<T> = { ok: true; value: T } | { ok: false; code: string };

/** The repositories below the workspace; empty is the workspace's own. */
function repoQuery(repo: string | undefined): string {
  return repo ? `repo=${encodeURIComponent(repo)}` : "";
}

function withQuery(base: string, path: string, query: string): string {
  return query ? `${base}${path}?${query}` : `${base}${path}`;
}

/** The kernel's dotted refusal code from a non-2xx answer, or the bare status. */
async function refusalOf(response: Response): Promise<{ ok: false; code: string }> {
  try {
    const body = (await response.json()) as { code?: unknown };
    if (body && typeof body === "object" && typeof body.code === "string") {
      return { ok: false, code: body.code };
    }
  } catch {
    // A refusal that is not JSON still has an HTTP status.
  }
  return { ok: false, code: `http.${response.status}` };
}

/** A 200 whose body is not JSON is a shape refusal, not a dead socket. */
async function jsonOf(response: Response): Promise<{ ok: true; body: unknown } | { ok: false; code: string }> {
  try {
    return { ok: true, body: await response.json() };
  } catch {
    return { ok: false, code: "changes.shape" };
  }
}

/** A dead catch: the deadline and the dead socket are different facts, and
 *  the sentences a person can act on differ too. */
function transport(error: unknown): { ok: false; code: string } {
  return { ok: false, code: error instanceof RequestTimeout ? "client.timeout" : "client.offline" };
}

async function get<T>(
  url: string,
  parse: (body: unknown) => T,
  timeoutMs = 12_000,
  signal?: AbortSignal,
): Promise<ChangesReply<T>> {
  try {
    const response = await fetchWithTimeout(
      url,
      { credentials: "same-origin", ...(signal ? { signal } : {}) },
      timeoutMs,
    );
    if (!response.ok) return refusalOf(response);
    const body = await jsonOf(response);
    if (!body.ok) return body;
    return { ok: true, value: parse(body.body) };
  } catch (error) {
    return transport(error);
  }
}

/** The working tree's changes; `repo:false` means not a git repository. */
export function loadChanges(base: string, repo?: string): Promise<ChangesReply<WorkspaceChanges>> {
  return get(withQuery(base, "/changes", repoQuery(repo)), parseWorkspaceChanges);
}

/** One path's unified working-tree diff. */
export function loadDiff(
  base: string,
  path: string,
  repo?: string,
): Promise<ChangesReply<ChangeDiff>> {
  const query = `path=${encodeURIComponent(path)}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`;
  return get(withQuery(base, "/changes/diff", query), (body) => parseChangeDiff(body, path));
}

/** The work tree's git identity: branch, detached flag, change counts. */
export function loadWorkspaceGit(
  base: string,
  repo?: string,
): Promise<ChangesReply<WorkspaceGitView>> {
  return get(withQuery(base, "/workspace/git", repoQuery(repo)), parseWorkspaceGit);
}

/** The repositories below the workspace; an old kernel answers 404/501 without a code. */
export function loadGitRepos(base: string): Promise<ChangesReply<GitReposView>> {
  return get(`${base}/git/repos`, parseGitRepos);
}

/** The newest commits, newest first. */
export function loadHistory(
  base: string,
  repo?: string,
  limit = 100,
): Promise<ChangesReply<GitHistory>> {
  const query = `limit=${limit}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`;
  return get(withQuery(base, "/workspace/git/log", query), parseGitHistory, 15_000);
}

/** One recorded commit's files. */
export function loadCommitFiles(
  base: string,
  id: string,
  repo?: string,
): Promise<ChangesReply<GitCommitFiles>> {
  const query = `id=${encodeURIComponent(id)}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`;
  return get(withQuery(base, "/git/commit", query), parseGitCommitFiles);
}

/** One recorded commit file's diff. */
export function loadCommitDiff(
  base: string,
  id: string,
  path: string,
  repo?: string,
): Promise<ChangesReply<ChangeDiff>> {
  const query = `id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}${
    repo ? `&repo=${encodeURIComponent(repo)}` : ""
  }`;
  return get(withQuery(base, "/git/commit/diff", query), (body) => parseChangeDiff(body, path));
}

/** One folder's listing, or the paths a search matched. */
export function listFiles(
  base: string,
  path = "",
  query = "",
): Promise<ChangesReply<WorkspaceListing>> {
  const parts: string[] = [];
  if (path) parts.push(`path=${encodeURIComponent(path)}`);
  if (query) parts.push(`q=${encodeURIComponent(query)}`);
  return get(withQuery(base, "/workspace/files", parts.join("&")), parseWorkspaceListing);
}

/** One file's text content; binaries and files past the kernel's bound refuse. */
export function readFile(base: string, path: string): Promise<ChangesReply<WorkspaceFile>> {
  return get(
    withQuery(base, "/workspace/file", `path=${encodeURIComponent(path)}`),
    (body) => parseWorkspaceFile(body, path),
    15_000,
  );
}

export interface StageRequest {
  repo?: string;
  paths?: string[];
  all?: boolean;
  unstage?: boolean;
}

async function sendNoContent(
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; code: string }> {
  try {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    }, timeoutMs);
    if (!response.ok) return refusalOf(response);
    return { ok: true };
  } catch (error) {
    return transport(error);
  }
}

async function sendFor<T>(
  url: string,
  body: unknown,
  timeoutMs: number,
  parse: (raw: unknown) => T,
  signal?: AbortSignal,
): Promise<ChangesReply<T>> {
  try {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      ...(signal ? { signal } : {}),
      body: JSON.stringify(body),
    }, timeoutMs);
    if (!response.ok) return refusalOf(response);
    const parsed = await jsonOf(response);
    if (!parsed.ok) return parsed;
    return { ok: true, value: parse(parsed.body) };
  } catch (error) {
    return transport(error);
  }
}

/** Move the named changes into the index, or out of it when `unstage`. */
export function stageChanges(base: string, req: StageRequest): Promise<{ ok: true } | { ok: false; code: string }> {
  return sendNoContent(`${base}/changes/stage`, req, 15_000);
}

/**
 * The model reads the staged diff and drafts a message. Turn-sized wait: the
 * draft is a model call, and the kernel answers nothing until it is done. A
 * new draft aborts the one before it through the caller's signal.
 */
export function proposeCommit(
  base: string,
  repo?: string,
  signal?: AbortSignal,
): Promise<ChangesReply<CommitProposal>> {
  return sendFor(
    withQuery(base, "/commit/propose", repoQuery(repo)),
    {},
    120_000,
    parseCommitProposal,
    signal,
  );
}

/**
 * Record the commit the person confirmed. `fingerprint` names the staged set
 * the proposal read; the kernel refuses one that has moved on. The repository
 * travels in the body — the handler reads nothing from the query.
 */
export function commitStaged(
  base: string,
  req: CommitRequest,
): Promise<ChangesReply<CommitResult>> {
  return sendFor(`${base}/commit`, req, 30_000, parseCommitResult);
}

/** What a staging refusal means, in a sentence a person can act on. */
export function stageMessage(code: string): string {
  switch (code) {
    case "client.offline":
      return "连不上电脑，检查连接后重试。";
    case "client.timeout":
      return "电脑没有及时回应，稍后重试。";
    case "git.repo_unknown":
      return "这个仓库已经不在工作区列表里了。";
    case "commit.no_repository":
      return "这里不是 git 仓库。";
    case "stage.unknown_path":
      return "这个文件不在变更列表里了，刷新后再试。";
    case "stage.failed":
      return "暂存没有成功，稍后再试。";
    default:
      return `没暂存成：${code}`;
  }
}

/** What a commit refusal means. The secrets codes carry their own detail. */
export function commitMessage(code: string): string {
  switch (code) {
    case "client.offline":
      return "连不上电脑，检查连接后重试。";
    case "client.timeout":
      return "电脑没有及时回应，稍后重试。";
    case "git.repo_unknown":
      return "这个仓库已经不在工作区列表里了。";
    case "commit.no_repository":
      return "这里不是 git 仓库。";
    case "commit.nothing_staged":
      return "没有已暂存的变更，先勾选要提交的文件。";
    case "commit.staged_changed":
      return "暂存区刚发生了变化，重新起草再提交。";
    case "commit.secrets_staged":
      return "暂存的变更里疑似有密钥，确认后勾选\"这些可以提交\"再试。";
    case "commit.empty_message":
      return "提交信息不能为空。";
    case "commit.message_invalid":
      return "提交信息格式不对。";
    case "commit.message_too_long":
      return "提交信息太长了。";
    case "commit.identity_missing":
      return "电脑上的 git 没有配置提交身份，先在桌面端设置。";
    case "commit.failed":
    case "commit.git_failed":
      return "提交没有成功，稍后再试。";
    default:
      return `没提交成：${code}`;
  }
}

/** Why the model could not draft a message. */
export function draftFailureText(code: string): string {
  switch (code) {
    case "no_model":
      return "电脑上没有可用的模型，自己写提交信息。";
    case "timeout":
      return "起草超时了，自己写提交信息。";
    case "no_answer":
      return "模型没有给出草案，自己写提交信息。";
    case "model_failed":
      return "起草失败了，自己写提交信息。";
    default:
      return `起草失败（${code}），自己写提交信息。`;
  }
}

/** What a file read refusal means; the sentence names the next thing to do. */
export function fileMessage(code: string): string {
  switch (code) {
    case "client.offline":
      return "连不上电脑，检查连接后重试。";
    case "client.timeout":
      return "电脑没有及时回应，稍后重试。";
    case "workspace.file_missing":
      return "这个文件已经不在了。";
    case "workspace.preview_denied":
      return "没有权限读这个文件。";
    case "workspace.file_unreadable":
      return "这个文件读不出来：可能是二进制文件，或者太大了。";
    case "workspace.path_outside_tree":
      return "这个路径不在工作区里。";
    case "workspace.files_failed":
    case "workspace.file_failed":
      return "读取失败，稍后再试。";
    default:
      return `没读出来：${code}`;
  }
}
