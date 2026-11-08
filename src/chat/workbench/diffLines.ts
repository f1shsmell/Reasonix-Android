/**
 * A unified diff as lines with before/after numbers — a verbatim port of the
 * desktop's `UnifiedDiff.diffLines`. Unified only, never split; the `@@`
 * header is kept as its own row; file headers before the first hunk and git's
 * `\ No newline` note are skipped (inside a hunk a removed line may itself
 * begin with "--", so only the note is skipped). Pure: the same text gives the
 * same rows.
 */

export interface DiffLine {
  old?: number;
  now?: number;
  mark: " " | "+" | "-" | "@";
  text: string;
}

export function diffLines(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let old = 0;
  let now = 0;
  const lines = diff.replace(/\n$/, "").split("\n");
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      // The regex guarantees both groups; the index access still reads
      // `string | undefined` under noUncheckedIndexedAccess.
      old = Number(hunk[1] ?? "0");
      now = Number(hunk[2] ?? "0");
      out.push({ mark: "@", text: line });
    } else if (!out.length || line.startsWith("\\")) {
      continue;
    } else if (line.startsWith("+")) {
      out.push({ now: now, mark: "+", text: line.slice(1) });
      now += 1;
    } else if (line.startsWith("-")) {
      out.push({ old: old, mark: "-", text: line.slice(1) });
      old += 1;
    } else {
      out.push({ old: old, now: now, mark: " ", text: line.slice(1) });
      old += 1;
      now += 1;
    }
  }
  return out;
}
