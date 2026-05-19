#!/usr/bin/env node
'use strict';
/**
 * create-task.cjs — Lattice task creation/read helper.
 *
 * All commands operate on THIS workflow's project — no project string to
 * type, no chance of hitting the wrong board.
 *
 * Create one task (description from second arg or stdin):
 *   node create-task.cjs "Task title" "Short description"
 *   node create-task.cjs "Task title" < description.md
 *
 * Batch-create (recommended for 3+ tasks):
 *   node create-task.cjs --batch tasks.json
 *   # tasks.json: [{ "title": "...", "description": "..." }, ...]
 *
 * Read the board (defaults to this project; never queries another):
 *   node create-task.cjs --list                    # every task
 *   node create-task.cjs --list open               # one lane
 *   node create-task.cjs --list open,in_progress   # multiple lanes
 *   node create-task.cjs --summary                 # counts by status
 */

const http = require('http');
const fs   = require('fs');

const PROJECT  = '__LATTICE_PROJECT__';
const API_BASE = '__LATTICE_API_BASE__';

function request(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const url     = new URL(urlStr);
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = payload == null ? {} : {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port) || 80,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      },
    );
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

function post(urlStr, body) { return request('POST', urlStr, body); }
function get(urlStr)        { return request('GET',  urlStr, null); }

function projectQuery() {
  return 'project=' + encodeURIComponent(PROJECT);
}

// Defence in depth: even though the API canonicalizes and filters server-side,
// re-check that the envelope's canonicalProject matches PROJECT (case-insensitive
// drive letter) before acting on the data.
function assertEnvelopeMatchesProject(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('unexpected response shape from Lattice API');
  }
  const got = String(envelope.canonicalProject || '');
  if (got.toLowerCase() !== PROJECT.toLowerCase()) {
    throw new Error(
      'Lattice API returned data for the wrong project — got "' + got +
        '", expected "' + PROJECT + '". Refusing to act on it.',
    );
  }
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf.trim()));
  });
}

async function createOne(title, description) {
  const result = await post(API_BASE + '/api/tasks', { project: PROJECT, title, description });
  if (result.status >= 200 && result.status < 300) {
    const t = result.body;
    console.log('Created: "' + t.title + '" (id: ' + t.id + ')');
    return t;
  }
  const msg = (result.body && result.body.error) ? result.body.error : JSON.stringify(result.body);
  throw new Error('API ' + result.status + ': ' + msg);
}

async function listTasks(statusCsv) {
  const q = projectQuery() + (statusCsv ? '&status=' + encodeURIComponent(statusCsv) : '');
  const result = await get(API_BASE + '/api/tasks?' + q);
  if (result.status < 200 || result.status >= 300) {
    throw new Error('API ' + result.status + ': ' + JSON.stringify(result.body));
  }
  assertEnvelopeMatchesProject(result.body);
  const { tasks, count, mismatched } = result.body;
  if (!Array.isArray(tasks)) throw new Error('unexpected tasks shape: ' + JSON.stringify(result.body));
  if (mismatched > 0) {
    console.error('[warn] ' + mismatched + ' foreign task(s) filtered server-side (see backend log)');
  }
  console.log('Project: ' + PROJECT + '  (' + count + ' task' + (count === 1 ? '' : 's') + (statusCsv ? ', filter=' + statusCsv : '') + ')');
  for (const t of tasks) console.log(t.id + '  ' + t.status.padEnd(15) + '  ' + t.title);
}

async function summary() {
  const result = await get(API_BASE + '/api/tasks/summary?' + projectQuery());
  if (result.status < 200 || result.status >= 300) {
    throw new Error('API ' + result.status + ': ' + JSON.stringify(result.body));
  }
  assertEnvelopeMatchesProject(result.body);
  console.log(JSON.stringify({
    project: result.body.canonicalProject,
    total:   result.body.total,
    byStatus: result.body.byStatus,
  }, null, 2));
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--list') {
    await listTasks(args[1] || '');
    return;
  }
  if (args[0] === '--summary') {
    await summary();
    return;
  }

  if (args[0] === '--batch') {
    const file = args[1];
    if (!file) { console.error('Usage: node create-task.cjs --batch tasks.json'); process.exit(1); }
    let tasks;
    try { tasks = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { console.error('Could not read ' + file + ': ' + e.message); process.exit(1); }
    if (!Array.isArray(tasks)) { console.error('tasks.json must be a JSON array'); process.exit(1); }
    const result = await post(API_BASE + '/api/tasks/batch', { project: PROJECT, tasks });
    if (result.status >= 200 && result.status < 300) {
      const created = result.body;
      console.log('Created ' + created.length + ' task(s):');
      for (const t of created) console.log('  ' + t.title + ' (' + t.id + ')');
    } else {
      const msg = (result.body && result.body.error) ? result.body.error : JSON.stringify(result.body);
      console.error('API error: ' + msg);
      process.exit(1);
    }
    return;
  }

  const title = args[0];
  if (!title) {
    console.error('Usage: node create-task.cjs "Title" ["Description"]');
    console.error('       node create-task.cjs "Title" < description.md');
    console.error('       node create-task.cjs --batch tasks.json');
    console.error('       node create-task.cjs --list [statuses]');
    console.error('       node create-task.cjs --summary');
    process.exit(1);
  }
  const description = args[1] !== undefined ? args[1] : await readStdin();
  await createOne(title, description);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
