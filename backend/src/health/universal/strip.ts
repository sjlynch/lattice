import type { CommentSyntax } from './commentSyntax.js';
import { consumeRegexLiteral } from './stripRegex.js';

export type StripOptions = {
  // Blank string / template / regex literals. Default true.
  strings?: boolean;
  // Blank line + block comments. Default true.
  comments?: boolean;
};

export type StripScanner = {
  content: string;
  n: number;
  i: number;
  out: string[];
  blankStrings: boolean;
  blankComments: boolean;
  lineCommentPrefixes: string[];
  blockOpen?: string;
  blockClose?: string;
  quoteLifetimes: boolean;
};

function createScanner(content: string, syntax: CommentSyntax, options: StripOptions): StripScanner {
  return {
    content,
    n: content.length,
    i: 0,
    out: [],
    blankStrings: options.strings !== false,
    blankComments: options.comments !== false,
    lineCommentPrefixes: syntax.line ?? [],
    blockOpen: syntax.blockOpen,
    blockClose: syntax.blockClose,
    quoteLifetimes: syntax.quoteLifetimes === true,
  };
}

const IDENT_START_RE = /^[\p{L}_]$/u;

// Rust (`CommentSyntax.quoteLifetimes`): does the `'` at `i` open a lifetime or
// loop label rather than a char literal? A char literal is `'\…'` (escape) or
// exactly one code point closed by `'` (`'a'`, `'é'`, `'🦀'`); anything else
// starting with an identifier character (`'a`, `'static`, `'outer:`) is a
// lifetime/label. Everything else keeps the ordinary string handling.
function opensRustLifetime(content: string, i: number): boolean {
  if (i + 1 >= content.length || content[i + 1] === '\\') return false;
  const cp = content.codePointAt(i + 1) as number;
  const len = cp > 0xffff ? 2 : 1;
  if (content[i + 1 + len] === "'") return false;
  return IDENT_START_RE.test(String.fromCodePoint(cp));
}

function blankChar(scanner: StripScanner, ch: string): void {
  scanner.out.push(ch === '\n' ? '\n' : ' ');
}

function emitComment(scanner: StripScanner, ch: string): void {
  if (scanner.blankComments) blankChar(scanner, ch);
  else scanner.out.push(ch);
}

function emitString(scanner: StripScanner, ch: string): void {
  if (scanner.blankStrings) blankChar(scanner, ch);
  else scanner.out.push(ch);
}

function consumeBlockComment(scanner: StripScanner): void {
  const { content, n, blockOpen, blockClose } = scanner;
  const open = blockOpen as string;
  const closeIdx = blockClose ? content.indexOf(blockClose, scanner.i + open.length) : -1;
  const end = closeIdx === -1 ? n : closeIdx + (blockClose as string).length;
  for (; scanner.i < end; scanner.i++) emitComment(scanner, content[scanner.i]);
}

function consumeLineComment(scanner: StripScanner): void {
  const { content, n } = scanner;
  const eol = content.indexOf('\n', scanner.i);
  const end = eol === -1 ? n : eol;
  for (; scanner.i < end; scanner.i++) emitComment(scanner, content[scanner.i]);
}

function consumeSimpleString(scanner: StripScanner): void {
  const { content, n } = scanner;
  const quote = content[scanner.i];
  emitString(scanner, quote);
  scanner.i++;
  while (scanner.i < n) {
    const ch = content[scanner.i];
    if (ch === '\\' && scanner.i + 1 < n) {
      emitString(scanner, ch);
      emitString(scanner, content[scanner.i + 1]);
      scanner.i += 2;
      continue;
    }
    emitString(scanner, ch);
    scanner.i++;
    if (ch === quote) return;
  }
}

function consumeTemplate(scanner: StripScanner): void {
  const { content, n } = scanner;
  emitString(scanner, '`');
  scanner.i++;
  while (scanner.i < n) {
    const ch = content[scanner.i];
    if (ch === '\\' && scanner.i + 1 < n) {
      emitString(scanner, ch);
      emitString(scanner, content[scanner.i + 1]);
      scanner.i += 2;
      continue;
    }
    if (ch === '`') {
      emitString(scanner, ch);
      scanner.i++;
      return;
    }
    if (ch === '$' && scanner.i + 1 < n && content[scanner.i + 1] === '{') {
      emitString(scanner, '$');
      emitString(scanner, '{');
      scanner.i += 2;
      consumeInterpolation(scanner);
      continue;
    }
    emitString(scanner, ch);
    scanner.i++;
  }
}

// Lex the inside of a `${...}` as ordinary code (so interpolated numbers still
// count), tracking brace depth to find the matching `}`.
function consumeInterpolation(scanner: StripScanner): void {
  const { content, n } = scanner;
  let depth = 1;
  while (scanner.i < n) {
    if (consumeNonCode(scanner)) continue;
    const ch = content[scanner.i];
    if (ch === '{') {
      depth++;
      scanner.out.push('{');
      scanner.i++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        emitString(scanner, '}');
        scanner.i++;
        return;
      }
      scanner.out.push('}');
      scanner.i++;
      continue;
    }
    scanner.out.push(ch);
    scanner.i++;
  }
}

// Consume a comment / string / template / regex starting at the cursor.
// Returns false when the cursor sits on an ordinary code character.
function consumeNonCode(scanner: StripScanner): boolean {
  const { content, blockOpen, lineCommentPrefixes } = scanner;
  const ch = content[scanner.i];
  if (blockOpen && content.startsWith(blockOpen, scanner.i)) {
    consumeBlockComment(scanner);
    return true;
  }
  for (const prefix of lineCommentPrefixes) {
    if (content.startsWith(prefix, scanner.i)) {
      consumeLineComment(scanner);
      return true;
    }
  }
  if (ch === "'" && scanner.quoteLifetimes && opensRustLifetime(content, scanner.i)) {
    // Emit the tick as code; the identifier after it is lexed as code too.
    scanner.out.push(ch);
    scanner.i++;
    return true;
  }
  if (ch === '"' || ch === "'") {
    consumeSimpleString(scanner);
    return true;
  }
  if (ch === '`') {
    consumeTemplate(scanner);
    return true;
  }
  // Regex-vs-division disambiguation lives in the sibling module. It is NOT
  // gated on language: it runs for every extension, so in a non-JS file a `/`
  // after an operator/opening token with another `/` later on the same line
  // (a shell/YAML path like `x=/usr/local/`) is blanked like a regex too.
  if (scanner.blankStrings && ch === '/' && consumeRegexLiteral(scanner, emitString)) {
    return true;
  }
  return false;
}

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
  const scanner = createScanner(content, syntax, options);
  while (scanner.i < scanner.n) {
    if (consumeNonCode(scanner)) continue;
    scanner.out.push(scanner.content[scanner.i]);
    scanner.i++;
  }
  return scanner.out.join('');
}
