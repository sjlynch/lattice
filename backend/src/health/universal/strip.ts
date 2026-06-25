import type { CommentSyntax } from './commentSyntax.js';

export type StripOptions = {
  // Blank string / template / regex literals. Default true.
  strings?: boolean;
  // Blank line + block comments. Default true.
  comments?: boolean;
};

// Keywords after which a `/` begins a regex literal rather than division.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'do',
  'else',
  'yield',
  'await',
  'throw',
  'case',
]);

// Replace strings + comments with whitespace (preserving newlines) so that
// keyword/number/marker counting heuristics never see literal or commented
// text. Best-effort single-pass lexer.
//
// Beyond plain quotes and comments it understands two JS constructs a naive
// scanner gets wrong: `/regex/` literals (blanked like strings, so digits in a
// pattern aren't counted as magic numbers) and `${...}` template
// interpolations (lexed as ordinary code, so an interpolated `${42}` is still
// counted).
//
// `options` lets a caller blank only one of the two categories. smells.ts uses
// this to measure each smell in its intended context: the TODO matcher runs
// against a strings-blanked / comments-kept view, and the long-string matcher
// against a comments-blanked / strings-kept view.
export function stripStringsAndComments(
  content: string,
  syntax: CommentSyntax,
  options: StripOptions = {},
): string {
  const blankStrings = options.strings !== false;
  const blankComments = options.comments !== false;
  const out: string[] = [];
  const n = content.length;
  let i = 0;
  const lineCommentPrefixes = syntax.line ?? [];
  const blockOpen = syntax.blockOpen;
  const blockClose = syntax.blockClose;

  const blankChar = (ch: string): void => {
    out.push(ch === '\n' ? '\n' : ' ');
  };
  const emitComment = (ch: string): void => {
    if (blankComments) blankChar(ch);
    else out.push(ch);
  };
  const emitString = (ch: string): void => {
    if (blankStrings) blankChar(ch);
    else out.push(ch);
  };

  // Is the `/` at the cursor a regex literal (vs division)? Scan the emitted
  // output back to the previous significant token; division can only follow a
  // value-producing token (identifier, number, closing bracket, string, …).
  function regexAllowedHere(): boolean {
    let k = out.length - 1;
    while (k >= 0 && (out[k] === ' ' || out[k] === '\t' || out[k] === '\r' || out[k] === '\n')) {
      k--;
    }
    if (k < 0) return true;
    const p = out[k];
    // Value-ending tokens mean the `/` is division, not a regex. `<`/`>` are
    // here so JSX closing tags (`</div>`) never kick off a stray regex scan.
    if (/[\w$)\]}"'`<>\/]/.test(p)) {
      if (/[\w$]/.test(p)) {
        // Identifier/number/keyword — only a few keywords take a regex next.
        let s = k;
        while (s >= 0 && /[\w$]/.test(out[s])) s--;
        return REGEX_PRECEDING_KEYWORDS.has(out.slice(s + 1, k + 1).join(''));
      }
      return false;
    }
    return true;
  }

  // content[i] === '/'. Index just past a single-line regex literal (incl.
  // flags), or -1 when it isn't one (so the `/` is treated as division).
  function scanRegexLiteral(): number {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const ch = content[j];
      if (ch === '\n') return -1;
      if (ch === '\\') {
        if (j + 1 >= n || content[j + 1] === '\n') return -1;
        j += 2;
        continue;
      }
      if (inClass) {
        if (ch === ']') inClass = false;
        j++;
        continue;
      }
      if (ch === '[') {
        inClass = true;
        j++;
        continue;
      }
      if (ch === '/') {
        j++;
        while (j < n && /[a-z]/i.test(content[j])) j++;
        return j;
      }
      j++;
    }
    return -1;
  }

  function consumeRegex(): boolean {
    const end = scanRegexLiteral();
    if (end === -1) return false;
    for (; i < end; i++) emitString(content[i]);
    return true;
  }

  function consumeBlockComment(): void {
    const open = blockOpen as string;
    const closeIdx = blockClose ? content.indexOf(blockClose, i + open.length) : -1;
    const end = closeIdx === -1 ? n : closeIdx + (blockClose as string).length;
    for (; i < end; i++) emitComment(content[i]);
  }

  function consumeLineComment(): void {
    const eol = content.indexOf('\n', i);
    const end = eol === -1 ? n : eol;
    for (; i < end; i++) emitComment(content[i]);
  }

  function consumeSimpleString(): void {
    const quote = content[i];
    emitString(quote);
    i++;
    while (i < n) {
      const ch = content[i];
      if (ch === '\\' && i + 1 < n) {
        emitString(ch);
        emitString(content[i + 1]);
        i += 2;
        continue;
      }
      emitString(ch);
      i++;
      if (ch === quote) return;
    }
  }

  function consumeTemplate(): void {
    emitString('`');
    i++;
    while (i < n) {
      const ch = content[i];
      if (ch === '\\' && i + 1 < n) {
        emitString(ch);
        emitString(content[i + 1]);
        i += 2;
        continue;
      }
      if (ch === '`') {
        emitString(ch);
        i++;
        return;
      }
      if (ch === '$' && i + 1 < n && content[i + 1] === '{') {
        emitString('$');
        emitString('{');
        i += 2;
        consumeInterpolation();
        continue;
      }
      emitString(ch);
      i++;
    }
  }

  // Lex the inside of a `${...}` as ordinary code (so interpolated numbers
  // still count), tracking brace depth to find the matching `}`.
  function consumeInterpolation(): void {
    let depth = 1;
    while (i < n) {
      if (consumeNonCode()) continue;
      const ch = content[i];
      if (ch === '{') {
        depth++;
        out.push('{');
        i++;
        continue;
      }
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          emitString('}');
          i++;
          return;
        }
        out.push('}');
        i++;
        continue;
      }
      out.push(ch);
      i++;
    }
  }

  // Consume a comment / string / template / regex starting at the cursor.
  // Returns false when the cursor sits on an ordinary code character.
  function consumeNonCode(): boolean {
    const ch = content[i];
    if (blockOpen && content.startsWith(blockOpen, i)) {
      consumeBlockComment();
      return true;
    }
    for (const prefix of lineCommentPrefixes) {
      if (content.startsWith(prefix, i)) {
        consumeLineComment();
        return true;
      }
    }
    if (ch === '"' || ch === "'") {
      consumeSimpleString();
      return true;
    }
    if (ch === '`') {
      consumeTemplate();
      return true;
    }
    if (blankStrings && ch === '/' && regexAllowedHere() && consumeRegex()) {
      return true;
    }
    return false;
  }

  while (i < n) {
    if (consumeNonCode()) continue;
    out.push(content[i]);
    i++;
  }
  return out.join('');
}
