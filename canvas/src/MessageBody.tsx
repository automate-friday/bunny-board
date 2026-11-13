import { createContext, memo, useContext, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./messageBody.css";

// Agent messages render as GitHub-flavoured Markdown (tables, autolinked URLs, task lists,
// strikethrough) through react-markdown + remark-gfm. Raw HTML is never rendered (no
// rehype-raw), images are never fetched, and only allowed link schemes become anchors.
export function messageHref(value: string): string | undefined {
  const href = value.trim();
  if (/^(https?:|mailto:|paseo:)/i.test(href) || /^(\/[^/]|\.\.?\/|#)/.test(href)) return href;
  return undefined;
}
const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
const components: Components = {
  a: ({ href, children }) => href
    ? <a href={href} target="_blank" rel="noopener noreferrer" onPointerDown={stop} onClick={stop}>{children}</a>
    : <span>{children}</span>,
  // Show an image as a link to its source (or its alt text) instead of loading it.
  img: ({ src, alt }) => {
    const href = typeof src === "string" ? messageHref(src) : undefined;
    return href ? <a href={href} target="_blank" rel="noopener noreferrer" onPointerDown={stop} onClick={stop}>{alt || href}</a> : <span>{alt}</span>;
  },
  // Wide tables scroll sideways inside narrow panels instead of squashing every column.
  table: ({ children }) => <div className="message-table"><table>{children}</table></div>,
  input: ({ checked }) => <input type="checkbox" checked={!!checked} disabled readOnly />,
};
const urlTransform = (url: string) => messageHref(url) ?? "";
const plugins = [remarkGfm];

export const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }): ReactNode {
  return <div className="message-markdown" data-testid="message-markdown">
    <Markdown remarkPlugins={plugins} components={components} urlTransform={urlTransform}>{text.slice(0, 32000)}</Markdown>
    {text.length > 32000 ? <p>Formatted preview limited to 32,000 characters. Raw text retains the whole message.</p> : null}
  </div>;
});
// Raw text for an agent's reply in the conversation sidebar: the response's footer holds the
// toggle (ResponseFooter.tsx) and provides it here; null where no footer does (cards, previews),
// which keep the hover link on the message itself.
export const ResponseRawCtx = createContext<boolean | null>(null);
export function useResponseRaw(): boolean | undefined {
  return useContext(ResponseRawCtx) ?? undefined;
}

// `raw`: shown raw or formatted by whoever holds the toggle; left out, the message has its own link.
export function MessageBody({ text, compact = false, raw: rawProp }: { text: string; compact?: boolean; raw?: boolean }) {
  const [rawOwn, setRaw] = useState(false);
  const raw = rawProp ?? rawOwn;
  return <div className="message-body" data-testid="message-body" style={{ whiteSpace: "normal", ...(compact ? { maxHeight: 140, overflowY: "auto" } as const : {}) }}>
    {rawProp === undefined ? <button className="message-source" type="button" aria-pressed={raw} onPointerDown={e => e.stopPropagation()} onClick={() => setRaw(v => !v)}>{raw ? "Formatted" : "Raw text"}</button> : null}
    {raw ? <pre data-testid="message-raw" className="message-raw">{text}</pre> : <MarkdownMessage text={text} />}
  </div>;
}
