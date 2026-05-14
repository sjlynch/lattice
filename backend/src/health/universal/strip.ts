import type { CommentSyntax } from './commentSyntax.js';

// Replace strings + comments with whitespace (preserving newlines).
// Best-effort lexer; sufficient for keyword-counting heuristics.
export function stripStringsAndComments(
  content: string,
  syntax: CommentSyntax,
): string {
  const out: string[] = [];
  let i = 0;
  const n = content.length;
  const lineCommentPrefixes = syntax.line ?? [];
  const blockOpen = syntax.blockOpen;
  const blockClose = syntax.blockClose;

  while (i < n) {
    const c = content[i];

    if (blockOpen && content.startsWith(blockOpen, i)) {
      const closeIdx = blockClose
        ? content.indexOf(blockClose, i + blockOpen.length)
        : -1;
      const end = closeIdx === -1 ? n : closeIdx + (blockClose?.length ?? 0);
      for (let j = i; j < end; j++) {
        out.push(content[j] === '\n' ? '\n' : ' ');
      }
      i = end;
      continue;
    }

    let matchedLineComment = false;
    for (const prefix of lineCommentPrefixes) {
      if (content.startsWith(prefix, i)) {
        const eol = content.indexOf('\n', i);
        const end = eol === -1 ? n : eol;
        for (let j = i; j < end; j++) out.push(' ');
        i = end;
        matchedLineComment = true;
        break;
      }
    }
    if (matchedLineComment) continue;

    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out.push(' ');
      i++;
      while (i < n) {
        const ch = content[i];
        if (ch === '\\' && i + 1 < n) {
          out.push(content[i + 1] === '\n' ? '\n' : ' ');
          out.push(' ');
          i += 2;
          continue;
        }
        if (ch === quote) {
          out.push(' ');
          i++;
          break;
        }
        out.push(ch === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }

    out.push(c);
    i++;
  }
  return out.join('');
}
