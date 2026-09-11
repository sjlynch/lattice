import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startTscWatch, tscWatchArgs, type CompileResult } from '../../scripts/dev/tscWatch.mjs';
import { distContentSignature } from '../../scripts/dev/distSignature.mjs';
import { createCompilerLifecycle } from '../../scripts/dev/compilerLifecycle.mjs';
import { withTempDir, writeLayout } from './helpers/tempDir.js';

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const results: CompileResult[] = [];
  const lines: string[] = [];
  let starts = 0;
  const watcher = startTscWatch('test-tsc', {
    spawnProcess: (() => child) as unknown as typeof spawn,
    onCompileStart: () => { starts++; }, onCompileComplete: (result) => results.push(result),
    forwardOutput() {}, recordLine: (line) => { lines.push(line); },
  });
  return { child, watcher, results, lines, starts: () => starts };
}

test('compiler status parser distinguishes split zero-error completion, errors, and later recompiles', async () => {
  const f = fixture();
  f.child.emit('spawn');
  f.child.stdout.write('12:00:00 - Starting compilation in watch mode...\n');
  f.child.stdout.write('Found 2 errors. Watching for file changes.\r\n');
  assert.deepEqual(await f.watcher.tscSettledPromise, { successful: false, errors: 2 });
  f.child.stdout.write('File change detected. Starting incremental compilation...\nFound 0 erro');
  f.child.stdout.write('rs. Watching for file changes.\n');
  assert.equal(f.starts(), 2);
  assert.deepEqual(f.results, [{ successful: false, errors: 2 }, { successful: true, errors: 0 }]);
  f.child.stderr.write('fatal diagnostic detail\n');
  assert.equal(f.lines.at(-1), 'fatal diagnostic detail');
});

test('compiler death before a status line resolves unavailable rather than successful', async () => {
  const f = fixture();
  f.child.emit('exit', 4294967295, null);
  assert.equal(await f.watcher.tscSettledPromise, null);
  f.child.stdout.write('Found 0 errors. Watching for file changes.\n');
  assert.deepEqual(f.results, []);
});

test('a live child operation error does not disable future compiler status parsing', () => {
  const f = fixture();
  f.child.emit('spawn');
  f.child.emit('error', new Error('kill EPERM'));
  f.child.stdout.write('Starting incremental compilation...\nFound 0 errors. Watching for file changes.\n');
  assert.equal(f.starts(), 1);
  assert.deepEqual(f.results, [{ successful: true, errors: 0 }]);
});

test('quoted status text inside a TypeScript diagnostic cannot mark compilation successful', () => {
  const f = fixture();
  f.child.emit('spawn');
  f.child.stdout.write("file.ts(1,1): error TS2322: Type 'Found 0 errors. Watching for file changes.' is not assignable to type 'number'.\n");
  assert.deepEqual(f.results, []);
  f.child.stdout.write('9:20:00 AM - Found 1 error. Watching for file changes.\n');
  assert.deepEqual(f.results, [{ successful: false, errors: 1 }]);
});

test('watcher diagnostic retention bounds huge unterminated lines', () => {
  const f = fixture();
  f.child.stderr.write('x'.repeat(100_000));
  f.child.stderr.end();
  assert.ok(f.lines.length > 0);
  assert.ok(f.lines.every((line) => line.length <= 4096));
});

test('compiler exit diagnosis includes trailing stderr received after exit without delaying repair', async () => {
  const raw = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  const lines: string[] = [];
  const records: string[][] = [];
  let repairs = 0;
  const lifecycle = createCompilerLifecycle({
    tscBin: 'fixture',
    startWatch: (_bin, options) => startTscWatch('fixture', {
      ...options, spawnProcess: (() => raw) as unknown as typeof spawn,
      forwardOutput() {}, recordLine: (line) => { lines.push(line); },
    }),
    record: () => { records.push([...lines]); },
    schedule: () => { repairs++; return 1 as unknown as ReturnType<typeof setTimeout>; }, unschedule() {},
  });
  lifecycle.start(); raw.emit('spawn');
  raw.emit('exit', 4294967295, null);
  assert.equal(repairs, 1, 'repair starts independently of stream drainage');
  assert.equal(records.length, 0);
  raw.stderr.write('last fatal diagnostic without newline');
  raw.emit('close', 4294967295, null);
  assert.deepEqual(records, [['last fatal diagnostic without newline']]);
  lifecycle.stop();
});

test('recovery flags change source-file watching without promising Windows directory polling', () => {
  assert.equal(tscWatchArgs('tsc', false).includes('--watchFile'), false);
  const args = tscWatchArgs('tsc', true);
  assert.equal(args[args.indexOf('--watchFile') + 1], 'dynamicPriorityPolling');
  assert.equal(args.includes('--watchDirectory'), false);
  assert.equal(args[args.indexOf('--locale') + 1], 'en');
});

async function bounded<T>(promise: Promise<T>, milliseconds = 12000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('isolated compiler timed out')), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

test('real isolated TypeScript watcher compiles initial output and a subsequent edit with recovery flags', { timeout: 30000 }, async () => {
  const tscBin = path.resolve('node_modules/typescript/lib/tsc.js');
  await withTempDir('lattice-tsc-recovery-', async (root) => {
    await writeLayout(root, {
      'tsconfig.json': JSON.stringify({ compilerOptions: {
        target: 'ES2022', types: [], outDir: 'dist', rootDir: 'src', noEmitOnError: true,
      }, include: ['src/*.ts'] }),
      'src/index.ts': 'export const value = 1;\n',
    });
    const output: string[] = [];
    let nextCompile: ((result: CompileResult) => void) | undefined;
    const child = startTscWatch(tscBin, {
      cwd: root, polling: true, forwardOutput: (text) => { output.push(text); }, recordLine() {},
      onCompileComplete: (result) => nextCompile?.(result),
    });
    try {
      const initial = await bounded(child.tscSettledPromise);
      assert.equal(initial?.successful, true, output.join(''));
      assert.match(await fs.readFile(path.join(root, 'dist', 'index.js'), 'utf8'), /value = 1/);
      const next = new Promise<CompileResult>((resolve) => { nextCompile = resolve; });
      await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const value = 2;\n');
      assert.equal((await bounded(next)).successful, true, output.join(''));
      assert.match(await fs.readFile(path.join(root, 'dist', 'index.js'), 'utf8'), /value = 2/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await bounded(exited, 5000);
      }
    }
  });
});

test('completed-output signature ignores re-emission timestamps but catches changed bytes and removals', async () => {
  await withTempDir('lattice-dist-content-', async (root) => {
    await writeLayout(root, { 'index.js': 'export const value = 1;\n' });
    const first = distContentSignature(root);
    assert.ok(first);
    const file = path.join(root, 'index.js');
    const original = await fs.stat(file);
    await fs.writeFile(file, 'export const value = 1;\n');
    await fs.utimes(file, new Date(), new Date(Date.now() + 10000));
    assert.equal(distContentSignature(root), first);
    await fs.writeFile(file, 'export const value = 2;\n');
    await fs.utimes(file, original.atime, original.mtime);
    assert.notEqual(distContentSignature(root), first);
    await fs.unlink(file);
    assert.notEqual(distContentSignature(root), first);
  });
});
