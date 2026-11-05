// Lifted from getpaseo/paseo v0.11.4: packages/app/src/utils/diff-highlight.ts
// Copyright (c) 2025-present Mohamed Boudra, Apache-2.0, from getpaseo/paseo v0.11.4
// (see ./NOTICE.md). Changes: only diffLinePrefix and diffLineCode (now exported);
// highlightDiffLines is dropped because @getpaseo/highlight is not installed here.

import type { DiffLine } from "./tool-call-parsers";

// The leading diff marker glyph for a line. The code on the line is the content
// with this prefix removed; we render the glyph separately so token colors
// apply only to the code.
export function diffLinePrefix(line: DiffLine): string {
  switch (line.type) {
    case "add":
      return "+";
    case "remove":
      return "-";
    case "context":
      return " ";
    default:
      return "";
  }
}

export function diffLineCode(line: DiffLine): string {
  const { content, type } = line;
  if (type === "add" || type === "remove") {
    return content.startsWith(type === "add" ? "+" : "-") ? content.slice(1) : content;
  }
  if (type === "context") {
    return content.startsWith(" ") ? content.slice(1) : content;
  }
  return content;
}
