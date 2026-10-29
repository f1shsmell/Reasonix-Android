/**
 * Assistant text as Markdown.
 *
 * Raw HTML is deliberately not enabled (`rehype-raw` is absent), so a message
 * cannot inject markup into the phone UI. Links open outside the WebView;
 * tables scroll instead of forcing the bubble wider than the screen.
 *
 * The component is memoised by `text`: a long transcript re-renders on every
 * scroll, and parsing the same finished message again would be wasted work.
 */

import { isValidElement, memo } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton";
import { highlightCode } from "./highlight";
import "highlight.js/styles/github-dark.css";

/** The source text under a React node, used for the copy button. */
function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
  img: ({ src, alt }) => (
    <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />
  ),
  pre: ({ children }) => {
    const source = textOf(children).replace(/\n$/, "");
    return (
      <div className="code-block">
        <CopyButton text={source} label="复制代码" />
        <pre>{children}</pre>
      </div>
    );
  },
  code: ({ className, children }) => {
    const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
    if (!language) {
      return <code className={className}>{children}</code>;
    }
    const source = textOf(children).replace(/\n$/, "");
    const highlighted = highlightCode(source, language);
    if (highlighted === null) {
      return <code className={className}>{children}</code>;
    }
    // highlight.js escapes the source while tokenising it; this is generated
    // markup, not raw HTML from the model.
    return (
      <code
        className={`hljs ${className ?? ""}`.trim()}
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    );
  },
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
