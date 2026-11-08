import { useEffect, useRef, useState } from "react";
import { fileMessage, listFiles, readFile } from "../../net/changes";
import { highlightCode } from "../highlight";
import type { WorkspaceFile, WorkspaceListing } from "../../wire/changes";

/** The grammar a file extension maps to, for the read-only viewer. Unknown
 *  extensions render as plain text, which is always correct. */
function languageOf(name: string): string {
  const at = name.lastIndexOf(".");
  if (at < 0) return "";
  const extension = name.slice(at + 1).toLowerCase();
  const ALIASES: Record<string, string> = {
    cjs: "javascript",
    go: "go",
    h: "c",
    hpp: "cpp",
    html: "xml",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    kt: "kotlin",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rs: "rust",
    sh: "bash",
    sql: "sql",
    swift: "swift",
    ts: "typescript",
    tsx: "typescript",
    yml: "yaml",
  };
  return ALIASES[extension] ?? extension;
}

/** The workspace's own files, read-only: one folder at a time, a search that
 *  spans the tree, and a viewer for a single file's text. A port of the
 *  desktop's file tree read surface without the editor. A `jump` hands the
 *  viewer a path the diff's line numbers pointed at. */
export function FileBrowser({
  base,
  jump,
}: {
  base: string;
  jump?: { path: string; token: number } | null;
}) {
  const [path, setCurrent] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [error, setError] = useState("");
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [fileError, setFileError] = useState("");
  /** Guards every read (listing, open, jump) against an out-of-order older
   *  answer: the latest user intent wins. A per-effect `cancelled` flag would
   *  not span the three effects; the shared counter is the one id both the
   *  StrictMode re-mount and a quick tap sequence respect. */
  const requestId = useRef(0);

  useEffect(() => {
    const mine = ++requestId.current;
    setError("");
    void listFiles(base, path, search).then((reply) => {
      if (mine !== requestId.current) return;
      if (!reply.ok) {
        setError(fileMessage(reply.code));
        setListing(null);
        return;
      }
      setListing(reply.value);
    });
  }, [base, path, search]);

  // A search keystroke waits for the person to stop typing.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  // A jump from the diff's line numbers: open that file wherever it lives.
  useEffect(() => {
    if (!jump) return;
    const mine = ++requestId.current;
    setFileError("");
    const at = jump.path.lastIndexOf("/");
    setCurrent(at < 0 ? "" : jump.path.slice(0, at));
    void readFile(base, jump.path).then((reply) => {
      if (mine !== requestId.current) return;
      if (!reply.ok) {
        setFileError(fileMessage(reply.code));
        return;
      }
      setFile(reply.value);
    });
  }, [base, jump]);

  const open = (name: string): void => {
    // A search answers with workspace-relative paths no matter which folder
    // the search was typed from (the kernel ignores `path` when `q` is set),
    // so the name is the whole path there; a folder listing's names hang
    // under the current folder.
    const full = search ? name : path ? `${path}/${name}` : name;
    const mine = ++requestId.current;
    setFileError("");
    void readFile(base, full).then((reply) => {
      if (mine !== requestId.current) return;
      if (!reply.ok) {
        setFileError(fileMessage(reply.code));
        return;
      }
      setFile(reply.value);
    });
  };

  const up = (): void => {
    const at = path.lastIndexOf("/");
    setFile(null);
    setFileError("");
    setCurrent(at < 0 ? "" : path.slice(0, at));
  };

  if (file !== null) {
    const language = languageOf(file.path);
    const html = language ? highlightCode(file.content, language) : null;
    return (
      <div className="wb-files">
        <div className="wb-files-head">
          <button
            type="button"
            className="wb-files-up"
            onClick={() => {
              setFile(null);
              setFileError("");
            }}
          >
            ‹ 返回列表
          </button>
          <span className="wb-files-path">{file.path}</span>
        </div>
        {fileError && (
          <p className="wb-wait" role="alert">
            {fileError}
          </p>
        )}
        {html !== null ? (
          <pre className="wb-file-view">
            <code dangerouslySetInnerHTML={{ __html: html }} />
          </pre>
        ) : (
          <pre className="wb-file-view">{file.content}</pre>
        )}
      </div>
    );
  }

  const atRoot = path === "";
  return (
    <div className="wb-files">
      <div className="wb-files-head">
        {!atRoot && (
          <button type="button" className="wb-files-up" onClick={up}>
            ‹ 上一级
          </button>
        )}
        <span className="wb-files-path">{atRoot ? "工作区文件" : path}</span>
      </div>
      <input
        className="search wb-files-search"
        value={query}
        placeholder="搜索文件…"
        onChange={(event) => setQuery(event.target.value)}
      />
      {error && (
        <p className="wb-wait" role="alert">
          {error}
        </p>
      )}
      {listing !== null && (
        <div className="wb-tree">
          {!atRoot && !search && (
            <button type="button" className="wb-row" data-node="folder" onClick={up}>
              <span className="wb-row-main">..</span>
            </button>
          )}
          {listing.directories.map((dir) => {
            const name = dir.slice(dir.lastIndexOf("/") + 1);
            return (
              <button
                key={`d:${dir}`}
                type="button"
                className="wb-row"
                data-node="folder"
                onClick={() => {
                  // A directory found by search descends into itself and ends
                  // the search; the listing then reads that folder.
                  setQuery("");
                  setSearch("");
                  setFile(null);
                  setCurrent(dir);
                }}
              >
                <span className="wb-row-main">
                  <span className="wb-row-name">{search ? dir : name}</span>
                </span>
              </button>
            );
          })}
          {listing.files.map((name) => {
            const short = search ? name : name.slice(name.lastIndexOf("/") + 1);
            return (
              <button
                key={`f:${name}`}
                type="button"
                className="wb-row"
                data-node="file"
                onClick={() => open(name)}
              >
                <span className="wb-row-main">
                  <span className="wb-row-name">{short}</span>
                </span>
              </button>
            );
          })}
          {listing.directories.length === 0 && listing.files.length === 0 && (
            <p className="wb-wait">这里没有文件。</p>
          )}
        </div>
      )}
    </div>
  );
}
