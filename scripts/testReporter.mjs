// node:test reporter for agent consumption (`--test-reporter=<this file>`):
// prints only what a reader acts on — each failing test with its error, the
// captured console output of files that had a failure, and a one-line summary.
// The built-in `spec` reporter printed one line per passing test plus every
// log line of the code under test: ~375 KB (~94k tokens) for a passing backend
// run. A passing run now prints one line.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_ERROR_LINES = 30;
const MAX_OUTPUT_LINES = 40;

// Repo paths print relative to the repo root: shorter, and exactly what the
// reader passes back to `npm run test:file -- <path>`.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_POSIX = REPO.split(path.sep).join('/');
const REPO_PREFIXES = [`file:///${REPO_POSIX}/`, `${REPO_POSIX}/`, `${REPO}${path.sep}`];

function relative(text) {
  let out = String(text);
  for (const prefix of REPO_PREFIXES) out = out.split(prefix).join('');
  return out;
}

// The runner reports one file both relative (as given) and absolute.
function fileKey(file) {
  return file ? path.resolve(file) : '';
}

function shownFile(file) {
  return relative(fileKey(file)).split(path.sep).join('/');
}

// "A subtest failed" — the failing child is already reported itself.
function isRollup(data) {
  return data.details?.error?.failureType === 'subtestsFailed';
}

// Runner/runtime frames — located in `node:*` or at `(<anonymous>)` — never
// locate the bug. (A test's own frame is often `TestContext.<anonymous> (file…)`:
// only the LOCATION decides.)
const NOISE_FRAME = /^\s+at (?:async )?(?:node:|.*\((?:node:[^)]*|<anonymous>)\)\s*$)/;

function errorText(error) {
  const e = error?.cause ?? error;
  if (!e) return '  unknown failure';
  const text = (typeof e.stack === 'string' && e.stack) || String(e.message ?? e);
  const lines = relative(text).split('\n').filter((l) => !NOISE_FRAME.test(l));
  const head = lines.slice(0, MAX_ERROR_LINES);
  if (lines.length > MAX_ERROR_LINES) head.push(`... ${lines.length - MAX_ERROR_LINES} more lines`);
  return head.map((l) => `  ${l}`).join('\n');
}

export default async function* agentReporter(source) {
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0 };
  const names = new Map(); // file -> the current test-name path by nesting
  const output = new Map(); // file -> captured stdout/stderr lines
  const failedFiles = new Set();
  const started = Date.now();

  for await (const { type, data } of source) {
    const key = fileKey(data?.file);
    if (type === 'test:start') {
      const current = names.get(key) ?? [];
      current.length = data.nesting;
      current[data.nesting] = data.name;
      names.set(key, current);
    } else if (type === 'test:stdout' || type === 'test:stderr') {
      const lines = output.get(key) ?? [];
      lines.push(...String(data.message).replace(/\n$/, '').split('\n'));
      if (lines.length > MAX_OUTPUT_LINES * 4) lines.splice(0, lines.length - MAX_OUTPUT_LINES * 2);
      output.set(key, lines);
    } else if (type === 'test:pass') {
      if (data.details?.type === 'suite') continue;
      if (data.skip) counts.skipped++;
      else if (data.todo) counts.todo++;
      else counts.passed++;
    } else if (type === 'test:fail') {
      if (data.todo) { counts.todo++; continue; }
      if (isRollup(data)) continue;
      if (data.details?.type !== 'suite') counts.failed++;
      if (key) failedFiles.add(key);
      // A file that crashed while loading fails as one "test" named after itself.
      if (data.nesting === 0 && key && fileKey(data.name) === key) {
        yield `FAIL ${shownFile(key)} (the file crashed or failed to load; its console output is below)\n\n`;
        continue;
      }
      const testPath = [...(names.get(key) ?? []).slice(0, data.nesting), data.name].join(' > ');
      const at = key ? ` (${shownFile(key)}${data.line ? `:${data.line}` : ''})` : '';
      yield `FAIL ${testPath}${at}\n${errorText(data.details?.error)}\n\n`;
    }
  }

  for (const key of failedFiles) {
    const lines = output.get(key);
    if (!lines?.length) continue;
    const tail = lines.filter((l) => !NOISE_FRAME.test(l)).slice(-MAX_OUTPUT_LINES);
    yield `--- console output of ${shownFile(key)} (last ${tail.length} lines) ---\n${relative(tail.join('\n'))}\n\n`;
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const extra = [counts.skipped ? `skipped ${counts.skipped}` : '', counts.todo ? `todo ${counts.todo}` : '']
    .filter(Boolean).join(' | ');
  const total = counts.passed + counts.failed;
  yield `${counts.failed ? 'FAILED' : 'ok'}: ${total} tests | passed ${counts.passed} | failed ${counts.failed}${extra ? ` | ${extra}` : ''} | ${seconds}s\n`;
}
