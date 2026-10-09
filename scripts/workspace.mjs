#!/usr/bin/env node
// Root entry points, one command per check across both packages:
//   npm run typecheck                backend `tsc --noEmit` + frontend `tsc -b`
//   npm test                         both suites, backend then frontend (not in
//                                    parallel: real-worker tests are load-sensitive)
//   npm run test:file -- <arg>...    test files in whichever package owns them; an
//                                    arg is a path, or a module name (`crashLog`
//                                    runs crashLog.test.ts + crashLog.*.test.ts)
//
// Each package's own package.json script stays the single definition: it is run
// with that package as cwd — never `npm --prefix` (scripts/CLAUDE.md) — by
// spawning node directly on the script's words, so no shell parses file paths.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['backend', 'frontend'];

function scriptArgv(pkg, name) {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, pkg, 'package.json'), 'utf8'));
  const script = pkgJson.scripts?.[name];
  if (!script) throw new Error(`${pkg}/package.json has no "${name}" script`);
  if (/["'`$&|;<>()]/.test(script)) {
    throw new Error(`${pkg} "${name}" must be a plain command line (no quotes or shell syntax): ${script}`);
  }
  const [bin, ...args] = script.trim().split(/\s+/);
  if (bin === 'node') return [process.execPath, args];
  if (bin === 'tsc') return [process.execPath, [path.join(ROOT, pkg, 'node_modules', 'typescript', 'bin', 'tsc'), ...args]];
  throw new Error(`${pkg} "${name}": workspace.mjs runs only node / tsc scripts, not ${bin}`);
}

function run(pkg, name, extra = [], { capture = false } = {}) {
  const [cmd, args] = scriptArgv(pkg, name);
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args, ...extra], {
      cwd: path.join(ROOT, pkg),
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let out = '';
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { out += d; });
    child.on('error', (err) => resolve({ code: 1, out: `${out}${err.message}\n` }));
    child.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), out }));
  });
}

async function typecheck() {
  const results = await Promise.all(PACKAGES.map((pkg) => run(pkg, 'typecheck', [], { capture: true })));
  let failed = false;
  PACKAGES.forEach((pkg, i) => {
    const { code, out } = results[i];
    if (code === 0) console.log(`${pkg} typecheck: ok`);
    else { failed = true; console.log(`${pkg} typecheck: FAILED\n${out.trimEnd()}`); }
  });
  return failed ? 1 : 0;
}

async function test() {
  let failed = false;
  for (const pkg of PACKAGES) {
    console.log(`${pkg}:`);
    if ((await run(pkg, 'test')).code !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

// Resolve one arg to test files, grouped by owning package.
function resolveTestArg(arg, cwd) {
  const asPath = path.resolve(cwd, arg);
  if (fs.existsSync(asPath)) {
    const rel = path.relative(ROOT, asPath).split(path.sep);
    if (PACKAGES.includes(rel[0])) return [[rel[0], rel.slice(1).join('/')]];
    throw new Error(`${arg} is not inside ${PACKAGES.join(' or ')}`);
  }
  const name = arg.replace(/\.test\.tsx?$/, '');
  const found = [];
  for (const pkg of PACKAGES) {
    const dir = path.join(ROOT, pkg, 'src', '__tests__');
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (f === `${name}.test.ts` || (f.startsWith(`${name}.`) && f.endsWith('.test.ts'))) {
        found.push([pkg, `src/__tests__/${f}`]);
      }
    }
  }
  if (found.length === 0) throw new Error(`no test file or module named "${arg}" in ${PACKAGES.join('/')}/src/__tests__`);
  return found;
}

async function testFile(args) {
  if (args.length === 0) throw new Error('usage: npm run test:file -- <path or module name>...');
  const cwd = process.env.INIT_CWD || process.cwd();
  const byPkg = new Map();
  for (const arg of args) {
    for (const [pkg, file] of resolveTestArg(arg, cwd)) byPkg.set(pkg, [...(byPkg.get(pkg) ?? []), file]);
  }
  let failed = false;
  for (const [pkg, files] of byPkg) {
    if (byPkg.size > 1) console.log(`${pkg}:`);
    if ((await run(pkg, 'test:file', files)).code !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

const [command, ...rest] = process.argv.slice(2);
const commands = { typecheck, test, 'test-file': () => testFile(rest) };
try {
  if (!commands[command]) throw new Error(`unknown command "${command}" (expected: ${Object.keys(commands).join(', ')})`);
  process.exitCode = await commands[command]();
} catch (err) {
  console.error(`workspace: ${err.message}`);
  process.exitCode = 2;
}
