/**
 * The whole release note, for the row whose one-line summary is cut short.
 *
 * The updater only has room for one sentence under a settings row, and a
 * release note is written for reading: headings, short lists, a paragraph or
 * two. Rendering it as Markdown would pull in the transcript's component set
 * (code copy buttons, KaTeX, external links that cannot resolve a relative
 * `../../docs/...` path inside the app WebView), so this draws the small
 * subset a release note actually uses and nothing else.
 */

import { useBackCloser } from "./backStack";

/** Inline emphasis and links carry no meaning once the target is gone. */
function plain(line: string): string {
  return line
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*/g, "")
    .trim();
}

type Block =
  | { kind: "heading"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "para"; text: string };

/**
 * Split a note into the blocks it is written in. A blank line ends a list, so
 * two lists separated by prose stay separate.
 */
export function parseNotes(notes: string): Block[] {
  const blocks: Block[] = [];
  let items: string[] = [];
  const flush = () => {
    if (items.length > 0) {
      blocks.push({ kind: "list", items });
      items = [];
    }
  };
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith("#")) {
      flush();
      const text = plain(line.replace(/^#+\s*/, ""));
      if (text) blocks.push({ kind: "heading", text });
      continue;
    }
    if (line.startsWith(">")) {
      flush();
      const text = plain(line.replace(/^>\s*/, ""));
      if (text) blocks.push({ kind: "quote", text });
      continue;
    }
    if (/^[-*•]\s+/.test(line)) {
      const text = plain(line.replace(/^[-*•]\s+/, ""));
      if (text) items.push(text);
      continue;
    }
    flush();
    blocks.push({ kind: "para", text: plain(line) });
  }
  flush();
  return blocks;
}

export function ReleaseNotesSheet({
  version,
  notes,
  onClose,
}: {
  version: string;
  notes: string;
  onClose: () => void;
}) {
  useBackCloser(true, onClose);
  const blocks = parseNotes(notes);
  // The note opens with "# 0.2.7", which the sheet title already says.
  if (blocks[0]?.kind === "heading" && blocks[0].text === version) blocks.shift();

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        className="sheet release-notes"
        role="dialog"
        aria-modal="true"
        aria-label={`${version} 更新说明`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>{version} 更新说明</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="release-notes-body">
          {blocks.map((block, index) => {
            switch (block.kind) {
              case "heading":
                return <h3 key={index}>{block.text}</h3>;
              case "quote":
                return <p key={index} className="release-notes-quote">{block.text}</p>;
              case "list":
                return (
                  <ul key={index}>
                    {block.items.map((item, at) => (
                      <li key={at}>{item}</li>
                    ))}
                  </ul>
                );
              case "para":
                return <p key={index}>{block.text}</p>;
            }
          })}
        </div>
        <div className="sheet-foot">
          <button type="button" className="primary" onClick={onClose}>
            知道了
          </button>
        </div>
      </section>
    </div>
  );
}
