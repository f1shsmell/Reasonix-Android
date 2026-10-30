/**
 * The sidebar's shape, as the kernel already builds it for the desktop.
 *
 * `GET /tree` is one array of projects, each carrying its newest conversations.
 * The phone reads the same list rather than inventing one: a project is a
 * folder the desktop remembers, and a conversation is a transcript inside it.
 * Only the fields this client draws are named; everything else is ignored, so
 * the kernel may keep growing rows.
 */

/** One conversation inside a project. */
export interface TreeSession {
  /** Transcript path; this is what opens the conversation. */
  path: string;
  /** Transcript file stem, used when no title has been generated yet. */
  name: string;
  /** Generated or user-typed title, when there is one. */
  title?: string;
  turns?: number;
  /** Set when a pane already has this conversation open. */
  runtimeId?: string;
  archived?: boolean;
  pinned?: boolean;
  /** Unix milliseconds of the last write; absent when unknown. */
  lastActiveAt?: number;
  /** A turn finished since the person last looked. */
  unread?: boolean;
  legacy?: boolean;
}

/** One folder: the unit a phone shows first. */
export interface TreeProject {
  root: string;
  name: string;
  /** Every working directory folded into this project (worktrees). */
  workspaceRoots?: string[];
  /** A pane is driving this folder right now. */
  open?: boolean;
  /** The person chose this folder, rather than a window launching in it. */
  remembered?: boolean;
  /** The folder is gone from disk. */
  missing?: boolean;
  /** Conversations the folder lists, archived ones included. */
  total: number;
  archived?: number;
  /** Rows the window left out; what "show more" would still bring. */
  remaining: number;
  sessions: TreeSession[];
}
