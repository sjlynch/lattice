import type { CommentSyntax } from './commentSyntax.js';

export type LineCounts = {
  total: number;
  blank: number;
  comment: number;
  code: number;
};

// Counts blank/comment/code lines using the language's comment markers.
export function countLineKinds(content: string, syntax: CommentSyntax): LineCounts {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let blank = 0;
  let comment = 0;
  let code = 0;
  let inBlock = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      blank++;
      continue;
    }
    if (inBlock) {
      comment++;
      if (syntax.blockClose && line.includes(syntax.blockClose)) inBlock = false;
      continue;
    }
    if (syntax.blockOpen && line.startsWith(syntax.blockOpen)) {
      comment++;
      if (!syntax.blockClose || !line.includes(syntax.blockClose, syntax.blockOpen.length)) {
        inBlock = true;
      }
      continue;
    }
    let matchedComment = false;
    if (syntax.line) {
      for (const prefix of syntax.line) {
        if (line.startsWith(prefix)) {
          matchedComment = true;
          break;
        }
      }
    }
    if (matchedComment) comment++;
    else code++;
  }
  return { total: lines.length, blank, comment, code };
}
