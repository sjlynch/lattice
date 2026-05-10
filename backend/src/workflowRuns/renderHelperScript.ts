import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const helperScriptTemplate = fs.readFileSync(
  path.resolve(__dirname, 'create-task-template.cjs'),
  'utf8',
);

function escapeForTemplate(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

// Returns a standalone CommonJS Node script written to the step dir.
// Using .cjs avoids ESM/CJS ambiguity regardless of the project's
// package.json "type" setting — Node always interprets .cjs as CommonJS.
export function renderHelperScript(projectPath: string, backendOrigin: string): string {
  return helperScriptTemplate
    .replace('__LATTICE_PROJECT__', escapeForTemplate(projectPath))
    .replace('__LATTICE_API_BASE__', escapeForTemplate(backendOrigin));
}
