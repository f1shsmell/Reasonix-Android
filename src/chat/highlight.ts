/**
 * Syntax highlighting, bundled rather than fetched.
 *
 * The WebView may have no network at all, so a CDN or a runtime grammar
 * download is not an option. Only the languages an agent transcript actually
 * produces are registered; `highlight.js/lib/core` keeps the rest out.
 */

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  python,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

for (const [name, language] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, language);
}

/** Fence labels people actually write, mapped to the registered grammar. */
const ALIASES: Record<string, string> = {
  cjs: "javascript",
  docker: "dockerfile",
  html: "xml",
  js: "javascript",
  jsx: "javascript",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
  zsh: "bash",
};

/**
 * Highlight one fenced block.
 *
 * Returns `null` when the fence names a language this build does not carry:
 * the caller then renders the source as plain text, which is always correct.
 * The returned string is HTML produced by highlight.js, which escapes the
 * source itself; it is not user-authored HTML.
 */
export function highlightCode(source: string, language: string): string | null {
  const requested = language.toLowerCase();
  const name = ALIASES[requested] ?? requested;
  if (!hljs.getLanguage(name)) return null;
  try {
    return hljs.highlight(source, { language: name, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
