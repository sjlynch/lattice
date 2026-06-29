# backend/src/health/universal

Regex/lexer fallbacks used when a language lacks a tree-sitter grammar or when
AST metrics need a text-level pass.

- `strip.ts` owns `stripStringsAndComments`; it must preserve input length and
  newline positions so downstream ranges/line counts stay aligned.
- The lexer distinguishes string, template interpolation, line-comment, and
  block-comment modes. Template `${...}` code is intentionally re-entered so
  regex smells can still see expressions inside templates.
- Keep the regex-vs-division heuristic conservative; false positives in JS/TS
  quickly distort universal smells.
- `commentSyntax.ts` is the per-language marker table; update it before adding
  ad-hoc comment regexes elsewhere.
- `lineCounts.ts` counts blank/comment/code lines from source text and comment
  syntax, not AST nodes.
- `smells.ts` should stay heuristic-only; AST-backed smells belong in
  `health/walker/`.
- Universal coverage lives in `backend/src/__tests__/universal.test.ts`.
