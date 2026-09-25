import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Inside a template literal a single backslash is a *string* escape, not a
// regex one: a RegExp built from the template "\d+\.json" runs as /d+.json/.
// Refactors that turn a regex literal into a template (to interpolate a length
// or prefix) have lost their escapes this way several times — most recently
// ac13fa0's project-identity BINDING_FILE_RE, whose "\." became "any character"
// so a stray "<hash>_json" file was parsed as a binding and threw for every
// project.
//
// This scans backend/src and frontend/src for a RegExp constructed directly
// from a template literal (OPENER below) and fails on any odd-length backslash
// run in its text, except the template-syntax escapes for a backtick or dollar.
// Regex escapes there must be doubled: "\\.", "\\d", "\\s".
// (Comments here avoid spelling OPENER out, or this file would scan itself.)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SCAN_ROOTS = [path.join(REPO_ROOT, 'backend', 'src'), path.join(REPO_ROOT, 'frontend', 'src')];
const SOURCE_EXT = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const OPENER = 'new RegExp(' + '`';

async function collectSourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
      await collectSourceFiles(full, out);
    } else if (SOURCE_EXT.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Single-backslash escapes in every `new RegExp(<template>)` of `source`. */
function lostRegExpEscapes(source: string): { offset: number; escape: string }[] {
  const found: { offset: number; escape: string }[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(OPENER, from);
    if (start < 0) return found;
    let i = start + OPENER.length;
    let depth = 0; // inside `${ … }`
    while (i < source.length) {
      const ch = source[i];
      if (depth > 0) {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
        i += 1;
        continue;
      }
      if (ch === '\\') {
        let run = 0;
        while (source[i + run] === '\\') run += 1;
        const next = source[i + run] ?? '';
        if (run % 2 === 1 && next !== '`' && next !== '$') {
          found.push({ offset: i, escape: `\\${next}` });
        }
        i += run + (run % 2 === 1 ? 1 : 0);
        continue;
      }
      if (ch === '`') break;
      if (ch === '$' && source[i + 1] === '{') {
        depth = 1;
        i += 2;
        continue;
      }
      i += 1;
    }
    from = i + 1;
  }
}

test('lostRegExpEscapes flags single-backslash regex escapes in a RegExp template', () => {
  const bad = OPENER + '^[a-f0-9]{${LEN}}\\.json$`)';
  assert.deepEqual(lostRegExpEscapes(bad).map((f) => f.escape), ['\\.']);
  assert.deepEqual(lostRegExpEscapes(OPENER + '\\d+_\\s`)').map((f) => f.escape), ['\\d', '\\s']);
  assert.deepEqual(lostRegExpEscapes(OPENER + '^[a-f0-9]{${LEN}}\\\\.json$`)'), []);
  assert.deepEqual(lostRegExpEscapes(OPENER + '"(?:[^"\\\\\\\\]|\\\\\\\\.)*"`)'), []);
  assert.deepEqual(lostRegExpEscapes(OPENER + 'a\\`b\\${c}`)'), []);
  assert.deepEqual(lostRegExpEscapes(OPENER + '${x.replace(/\\./g, "")}`)'), [], 'escapes inside ${} are code, not template text');
});

test('no RegExp built from a template in backend/src or frontend/src loses a regex escape', async () => {
  const offenders: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of await collectSourceFiles(root)) {
      const source = await fs.readFile(file, 'utf8');
      if (!source.includes(OPENER)) continue;
      for (const { offset, escape } of lostRegExpEscapes(source)) {
        const line = source.slice(0, offset).split('\n').length;
        offenders.push(`${path.relative(REPO_ROOT, file)}:${line} — ${escape} (write \\${escape})`);
      }
    }
  }
  assert.deepEqual(offenders, [], `single-backslash escapes are lost inside a template literal:\n${offenders.join('\n')}`);
});
