import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { renderHelperScript } from '../workflowRuns/renderHelperScript.js';
import { withTempDir } from './helpers/tempDir.js';

// The workflow-step `create-task.cjs` helper treats its first positional
// argument as a task title. A scout agent guessing `--help` used to file a
// real Open task titled "--help" (which a workflow Start step would then run).
// These drive the rendered script as the agent does and count what reaches the
// API: help and unknown flags must never make a request.

const PROJECT = 'C:\\fake\\project';

type Recorded = { method: string; url: string; body: string };

async function withFakeApi<T>(fn: (origin: string, calls: Recorded[]) => Promise<T>): Promise<T> {
  const calls: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method ?? '', url: req.url ?? '', body });
      const parsed = body ? JSON.parse(body) : {};
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 't_fake', title: parsed.title }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`, calls);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

type RunResult = { code: number; stdout: string; stderr: string };

function runHelper(script: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [script, ...args], (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
      resolve({ code, stdout, stderr });
    });
    // Non-TTY with an immediate EOF, like an agent's Bash tool.
    child.stdin?.end();
  });
}

async function withHelper(
  fn: (run: (...args: string[]) => Promise<RunResult>, calls: Recorded[]) => Promise<void>,
  project: string = PROJECT,
): Promise<void> {
  await withFakeApi(async (origin, calls) => {
    await withTempDir('lattice-create-task-', async (dir) => {
      const script = path.join(dir, 'create-task.cjs');
      await fs.writeFile(script, renderHelperScript(project, origin), 'utf8');
      await fn((...args) => runHelper(script, args), calls);
    });
  });
}

test('--help / -h / help print usage to stdout, exit 0, and create nothing', async () => {
  await withHelper(async (run, calls) => {
    for (const flag of ['--help', '-h', 'help']) {
      const r = await run(flag);
      assert.equal(r.code, 0, `${flag} exits 0`);
      assert.match(r.stdout, /--summary/, `${flag} lists the commands`);
      assert.ok(r.stdout.includes(PROJECT), `${flag} names the bound project`);
      assert.equal(r.stderr, '');
    }
    assert.deepEqual(calls, [], 'help never touches the API');
  });
});

test('an unknown option is refused and creates nothing', async () => {
  await withHelper(async (run, calls) => {
    for (const flag of ['--summery', '--version', '-x', '--list=all']) {
      const r = await run(flag, 'extra');
      assert.equal(r.code, 1, `${flag} exits 1`);
      assert.match(r.stderr, /Unknown option/);
      assert.match(r.stderr, /Nothing was created/);
    }
    assert.deepEqual(calls, []);
  });
});

test('too many positional arguments are refused instead of silently dropped', async () => {
  await withHelper(async (run, calls) => {
    const r = await run('Title', 'Desc', '--limit', '5');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Too many arguments/);
    assert.deepEqual(calls, []);
  });
});

test('`--` lets a title start with a dash', async () => {
  await withHelper(async (run, calls) => {
    const r = await run('--', '--weird title', 'desc');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/api/tasks');
    assert.deepEqual(JSON.parse(calls[0].body), {
      project: PROJECT,
      title: '--weird title',
      description: 'desc',
    });
  });
});

test('a plain "Title" "Description" still creates one task', async () => {
  await withHelper(async (run, calls) => {
    const r = await run('Fix the legend', 'It overlaps the graph');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Created: "Fix the legend"/);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].body), {
      project: PROJECT,
      title: 'Fix the legend',
      description: 'It overlaps the graph',
    });
  });
});

test('a project path with quotes and `$` replacement patterns renders verbatim', async () => {
  // `'` used to end the single-quoted literal (SyntaxError), and a string
  // replacement expanded `$$` / `$&` / `$'` into other text.
  const awkward = "C:\\Users\\O'Brien\\$$x\\$&y\\$'z\\$`w";
  await withHelper(async (run, calls) => {
    const r = await run('--help');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(awkward), `help names the exact project:\n${r.stdout}`);

    const created = await run('Title', 'Desc');
    assert.equal(created.code, 0, created.stderr);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].body).project, awkward);
  }, awkward);
});
