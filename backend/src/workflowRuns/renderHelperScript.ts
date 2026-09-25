import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const helperScriptTemplate = fs.readFileSync(
  path.resolve(__dirname, 'create-task-template.cjs'),
  'utf8',
);

// The template's tokens stand where a whole JS expression goes
// (`const PROJECT = __LATTICE_PROJECT__;`), so emit a complete, quoted string
// literal: JSON.stringify output is a valid JS string literal for any input,
// including `'` (a path like `C:\Users\O'Brien\proj`). The replacement is a
// function so String.prototype.replace doesn't expand `$$`, `$&`, `` $` `` or
// `$'` sequences that a path may contain.
function jsStringLiteral(value: string): () => string {
  const literal = JSON.stringify(value);
  return () => literal;
}

// Returns a standalone CommonJS Node script written to the step dir.
// Using .cjs avoids ESM/CJS ambiguity regardless of the project's
// package.json "type" setting — Node always interprets .cjs as CommonJS.
export function renderHelperScript(projectPath: string, backendOrigin: string): string {
  return helperScriptTemplate
    .replace('__LATTICE_PROJECT__', jsStringLiteral(projectPath))
    .replace('__LATTICE_API_BASE__', jsStringLiteral(backendOrigin));
}
