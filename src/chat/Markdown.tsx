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

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
