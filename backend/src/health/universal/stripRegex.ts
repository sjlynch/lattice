// JS/TS-specific regex-vs-division disambiguation for the strip lexer. Regex
// literals (`/pattern/flags`) look like division at the character level, so
// this is the one piece of `strip.ts` that is language-specific — it is only
// invoked for the JS family. Blanking a regex like a string keeps digits in a
// pattern (e.g. `/[0-9]{3}/`) from counting as magic numbers.

import type { StripScanner } from './strip.js';

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

// Is a `/` at the cursor a regex literal (vs division)? Scan the emitted
// output back to the previous significant token; division can only follow a
// value-producing token (identifier, number, closing bracket, string, …).
function regexAllowedHere(out: string[]): boolean {
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

// scanner.content[scanner.i] === '/'. Index just past a single-line regex
// literal (incl. flags), or -1 when it isn't one (so the `/` is treated as
// division).
function scanRegexLiteral(scanner: StripScanner): number {
  const { content, n } = scanner;
  let j = scanner.i + 1;
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

// Consume a regex literal at the cursor (blanking it like a string via the
// provided `emit`), advancing the scanner past it. Returns false when the `/`
// is division rather than a regex, leaving the cursor untouched.
export function consumeRegexLiteral(
  scanner: StripScanner,
  emit: (scanner: StripScanner, ch: string) => void,
): boolean {
  if (!regexAllowedHere(scanner.out)) return false;
  const end = scanRegexLiteral(scanner);
  if (end === -1) return false;
  for (; scanner.i < end; scanner.i++) emit(scanner, scanner.content[scanner.i]);
  return true;
}
