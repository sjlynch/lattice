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
 * Read the board, cheapest first (always this project, never another):
 *   node create-task.cjs --summary                 # counts + per-lane cost
 *   node create-task.cjs --list                    # active lanes, newest 100
 *   node create-task.cjs --list all                # include done + deleted
 *   node create-task.cjs --list open,in_progress   # specific lanes
 *   node create-task.cjs --list --since 30d --limit 20
 *   node create-task.cjs --find "graph legend"     # search instead of listing
 *   node create-task.cjs --find "legend" open,qa   # search within lanes
 *   node create-task.cjs --find "legend" --limit 5 # cap the hits (default 20)
 *   node create-task.cjs --get t_abc123            # one task, full text
 *
 * The API pages/clips by default (a real board is a megabyte of mostly-done
 * history), and every response carries a `hint` naming the next knob to turn.
 * This script prints that hint verbatim — follow it rather than guessing.
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

// A 413 is the API refusing to hand back a megabyte, not a failure: it carries
// the summary + the exact narrowing options. Print those instead of throwing a
// wall of JSON (or a stack trace) at the agent reading this output.
function reportTooLarge(body) {
  console.error('Response too large — Lattice refused to send it.');
  if (body && body.hint) console.error(body.hint);
  const suggestions = (body && Array.isArray(body.suggestions)) ? body.suggestions : [];
  for (const s of suggestions) console.error('  - ' + s);
  if (body && body.summary && body.summary.byStatus) {
    console.error('  counts: ' + JSON.stringify(body.summary.byStatus));
  }
}

// Every read goes through here so a 413 never reaches the caller as an error.
async function getEnvelope(urlStr) {
  const result = await get(urlStr);
  if (result.status === 413) {
    reportTooLarge(result.body);
    process.exit(1);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error('API ' + result.status + ': ' + JSON.stringify(result.body));
  }
  return result.body;
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

// `--list` with no lane sends NO status, so the API's own default applies:
// the ACTIVE lanes only, compact fields, newest 100. Done history (which is
// most of a mature board) stays out unless it is asked for by name.
async function listTasks(statusCsv, opts) {
  let q = projectQuery();
  if (statusCsv) q += '&status=' + encodeURIComponent(statusCsv);
  if (opts.since) q += '&since=' + encodeURIComponent(opts.since);
  if (opts.limit) q += '&limit=' + encodeURIComponent(opts.limit);
  const body = await getEnvelope(API_BASE + '/api/tasks?' + q);
  assertEnvelopeMatchesProject(body);
  const { tasks, count, mismatched } = body;
  if (!Array.isArray(tasks)) throw new Error('unexpected tasks shape: ' + JSON.stringify(body));
  if (mismatched > 0) {
    console.error('[warn] ' + mismatched + ' foreign task(s) filtered server-side (see backend log)');
  }
  const scope = statusCsv ? 'filter=' + statusCsv : 'active';
  console.log(
    'Project: ' + PROJECT + '  (' + count + ' ' + scope + ' task' + (count === 1 ? '' : 's') + ')',
  );
  for (const t of tasks) console.log(t.id + '  ' + t.status.padEnd(15) + '  ' + t.title);
  if (body.hint) console.log('\n' + body.hint);
}

async function findTasks(q, statusCsv, opts) {
  let url = API_BASE + '/api/tasks/search?' + projectQuery() + '&q=' + encodeURIComponent(q);
  if (statusCsv) url += '&status=' + encodeURIComponent(statusCsv);
  if (opts && opts.limit) url += '&limit=' + encodeURIComponent(opts.limit);
  const body = await getEnvelope(url);
  assertEnvelopeMatchesProject(body);
  const results = Array.isArray(body.results) ? body.results : [];
  console.log(
    'Project: ' + PROJECT + '  (' + results.length + ' match' +
      (results.length === 1 ? '' : 'es') + ' for "' + q + '")',
  );
  for (const r of results) {
    console.log(r.id + '  ' + String(r.status).padEnd(15) + '  ' + r.score + '  ' + r.title);
    if (r.snippet) console.log('      ' + String(r.snippet).replace(/\s+/g, ' '));
  }
  if (body.hint) console.log('\n' + body.hint);
}

// GET /api/tasks/:id returns a bare Task (not an envelope), so the project
// check is against the task's own projectPath.
async function getTask(id) {
  const result = await get(API_BASE + '/api/tasks/' + encodeURIComponent(id));
  if (result.status === 404) throw new Error('no task with id ' + id + ' on this board');
  if (result.status < 200 || result.status >= 300) {
    throw new Error('API ' + result.status + ': ' + JSON.stringify(result.body));
  }
  const t = result.body;
  if (!t || typeof t !== 'object') throw new Error('unexpected response shape from Lattice API');
  const owner = String(t.projectPath || '');
  if (owner && owner.toLowerCase() !== PROJECT.toLowerCase()) {
    throw new Error(
      'Task ' + id + ' belongs to "' + owner + '", not "' + PROJECT + '". Refusing to act on it.',
    );
  }
  console.log('# ' + t.title);
  console.log('id: ' + t.id + '   status: ' + t.status);
  if (t.description) console.log('\n' + t.description);
  if (t.summary) console.log('\n## Summary\n' + t.summary);
}

async function summary() {
  const body = await getEnvelope(API_BASE + '/api/tasks/summary?' + projectQuery());
  assertEnvelopeMatchesProject(body);
  console.log('Project: ' + body.canonicalProject + '  (' + body.total + ' tasks)');
  const lanes = body.lanes && typeof body.lanes === 'object' ? body.lanes : null;
  const byStatus = body.byStatus || {};
  for (const status of Object.keys(byStatus)) {
    const lane = lanes ? lanes[status] : null;
    const cost = lane && lane.approxTokens != null ? '  (~' + lane.approxTokens + ' tok full)' : '';
    console.log('  ' + status.padEnd(16) + String(byStatus[status]).padStart(4) + cost);
  }
  if (body.hint) console.log('\n' + body.hint);
}

// Pull `--since <v>` / `--limit <n>` out of the argv tail so `--list` / `--find`
// and their positional arguments keep their existing positions. (`--find` only
// honours `--limit`; search has no `since`.)
function parseReadOpts(args) {
  const opts = { since: '', limit: '' };
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--since' && args[i + 1] !== undefined) { opts.since = args[++i]; continue; }
    if (args[i] === '--limit' && args[i + 1] !== undefined) { opts.limit = args[++i]; continue; }
    rest.push(args[i]);
  }
  return { opts, rest };
}

function usage() {
  console.error('Usage: node create-task.cjs "Title" ["Description"]');
  console.error('       node create-task.cjs "Title" < description.md');
  console.error('       node create-task.cjs --batch tasks.json');
  console.error('       node create-task.cjs --summary');
  console.error('       node create-task.cjs --list [all|statuses] [--since 30d] [--limit N]');
  console.error('       node create-task.cjs --find "text" [statuses] [--limit N]');
  console.error('       node create-task.cjs --get <id>');
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--list') {
    const { opts, rest } = parseReadOpts(args.slice(1));
    await listTasks(rest[0] || '', opts);
    return;
  }
  if (args[0] === '--find') {
    // Strip the flags FIRST — otherwise `--find "x" --limit 2` reads `--limit`
    // as the lanes positional and searches a lane that doesn't exist.
    const { opts, rest } = parseReadOpts(args.slice(1));
    if (!rest[0]) { usage(); process.exit(1); }
    await findTasks(rest[0], rest[1] || '', opts);
    return;
  }
  if (args[0] === '--get') {
    if (!args[1]) { usage(); process.exit(1); }
    await getTask(args[1]);
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
  if (!title) { usage(); process.exit(1); }
  const description = args[1] !== undefined ? args[1] : await readStdin();
  await createOne(title, description);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
