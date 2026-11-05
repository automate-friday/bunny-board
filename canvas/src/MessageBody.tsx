import { Fragment, memo, useState, type ReactNode } from "react";
import "./messageBody.css";

// Render the message subset used by agents without executing HTML or fetching images.
// React escapes all text; only explicitly allowed link schemes become anchors.
export function messageHref(value: string): string | undefined {
  const href = value.trim();
  if (/^(https?:|mailto:|paseo:)/i.test(href) || /^(\/[^/]|\.\.?\/|#)/.test(href)) return href;
  return undefined;
}
function inline(text: string, depth = 0): ReactNode {
  if (depth > 12) return text;
  const result: ReactNode[] = []; let plain = "", i = 0;
  const emit = (node: ReactNode) => { if (plain) { result.push(plain); plain = ""; } result.push(<Fragment key={i}>{node}</Fragment>); };
  while (i < text.length) {
    const char = text[i];
    if (char === "\\" && i + 1 < text.length && /[!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~]/.test(text[i + 1])) { plain += text[i + 1]; i += 2; continue; }
    if (char === "`") {
      let n = 1; while (text[i + n] === "`") n++;
      const end = text.indexOf("`".repeat(n), i + n);
      if (end < 0) { plain += text.slice(i); break; }
      emit(<code>{text.slice(i + n, end)}</code>); i = end + n; continue;
    }
    if (char === "[") {
      const labelEnd = text.indexOf("](", i + 1), end = labelEnd < 0 ? -1 : text.indexOf(")", labelEnd + 2);
      // An unmatched delimiter consumes the remainder literally, never rescans suffixes.
      if (end < 0) { plain += text.slice(i); break; }
      const label = text.slice(i + 1, labelEnd), href = messageHref(text.slice(labelEnd + 2, end).split(/\s+/)[0]);
      emit(href ? <a href={href} target="_blank" rel="noopener noreferrer" onPointerDown={e => e.stopPropagation()}>{inline(label, depth + 1)}</a> : label); i = end + 1; continue;
    }
    if ((char === "*" || char === "_") && !(char === "_" && i > 0 && /\w/.test(text[i - 1]))) {
      let run = 1; while (text[i + run] === char) run++;
      if (run > 2) { plain += text.slice(i, i + run); i += run; continue; }
      const n = run, end = text.indexOf(char.repeat(n), i + n);
      if (end < 0) { plain += text.slice(i); break; }
      const content = inline(text.slice(i + n, end), depth + 1);
      emit(n === 2 ? <strong>{content}</strong> : <em>{content}</em>); i = end + n; continue;
    }
    plain += char; i++;
  }
  if (plain) result.push(plain); return result;
}
const listLine = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/;
function blocks(source: string, depth = 0): ReactNode[] {
  if (depth > 12) return [<pre key="deep">{source}</pre>];
  const lines = source.replace(/\r\n?/g, "\n").split("\n"), nodes: ReactNode[] = [];
  let i = 0;
  const startsBlock = (line: string) => /^(?: {0,3}(?:#{1,6}\s|`{3,}|~{3,}|>\s?)|\s*(?:[-+*]|\d+[.)])\s)/.test(line);
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const key = i, fence = lines[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const code: string[] = []; i++;
      const end = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (i < lines.length && !end.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      nodes.push(<pre key={key}><code data-language={fence[2].trim()}>{code.join("\n")}</code></pre>); continue;
    }
    const heading = lines[i].match(/^ {0,3}(#{1,6})\s+(.+)$/);
    if (heading) { const H = `h${heading[1].length}` as "h1"; nodes.push(<H key={key}>{inline(heading[2])}</H>); i++; continue; }
    if (/^ {0,3}>/.test(lines[i])) {
      const quote: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) quote.push(lines[i++].replace(/^ {0,3}> ?/, ""));
      nodes.push(<blockquote key={key}>{blocks(quote.join("\n"), depth + 1)}</blockquote>); continue;
    }
    const first = lines[i].match(listLine);
    if (first) {
      const indent = first[1].length, ordered = /^\d/.test(first[2]), items: ReactNode[] = [];
      while (i < lines.length) {
        const next = lines[i].match(listLine);
        if (!next || next[1].length !== indent || /^\d/.test(next[2]) !== ordered) break;
        const itemKey = i, content = [next[3]], contentIndent = next[1].length + next[2].length + 1; i++;
        while (i < lines.length && lines[i].trim() && (lines[i].match(/^\s*/)?.[0].length ?? 0) > indent) content.push(lines[i++].slice(contentIndent));
        items.push(<li key={itemKey}>{blocks(content.join("\n"), depth + 1)}</li>);
      }
      nodes.push(ordered ? <ol key={key} start={parseInt(first[2], 10)}>{items}</ol> : <ul key={key}>{items}</ul>); continue;
    }
    if (/^ {0,3}(?:---+|\*\*\*+|___+)\s*$/.test(lines[i])) { nodes.push(<hr key={key} />); i++; continue; }
    const paragraph = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) paragraph.push(lines[i++]);
    nodes.push(<p key={key}>{inline(paragraph.join("\n"))}</p>);
  }
  return nodes;
}
export const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }) {
  return <div className="message-markdown" data-testid="message-markdown">{blocks(text.slice(0, 32000))}{text.length > 32000 ? <p>Formatted preview limited to 32,000 characters. Raw text retains the whole message.</p> : null}</div>;
});
export function MessageBody({ text, compact = false }: { text: string; compact?: boolean }) {
  const [raw, setRaw] = useState(false);
  return <div className="message-body" data-testid="message-body" style={{ whiteSpace: "normal", ...(compact ? { maxHeight: 140, overflowY: "auto" } as const : {}) }}>
    <button className="message-source" type="button" aria-pressed={raw} onPointerDown={e => e.stopPropagation()} onClick={() => setRaw(v => !v)}>{raw ? "Formatted" : "Raw text"}</button>
    {raw ? <pre data-testid="message-raw" className="message-raw">{text}</pre> : <MarkdownMessage text={text} />}
  </div>;
}
