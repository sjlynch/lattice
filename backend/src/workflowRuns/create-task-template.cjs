#!/usr/bin/env node
'use strict';
/**
 * create-task.cjs — Lattice task creation helper.
 *
 * Handles JSON serialization so you never have to worry about shell
 * quoting, backticks, or special characters in descriptions.
 *
 * Single task (description from second arg):
 *   node create-task.cjs "Task title" "Short description"
 *
 * Single task (description from stdin — pipe or redirect file):
 *   node create-task.cjs "Task title" < description.md
 *   echo "My description" | node create-task.cjs "Task title"
 *
 * Multiple tasks at once (recommended for 3+ tasks):
 *   node create-task.cjs --batch tasks.json
 *
 * tasks.json format:
 *   [
 *     { "title": "First task",  "description": "What to do" },
 *     { "title": "Second task", "description": "..." }
 *   ]
 */

const http = require('http');
const fs   = require('fs');

const PROJECT  = '__LATTICE_PROJECT__';
const API_BASE = '__LATTICE_API_BASE__';

function post(urlStr, body) {
  return new Promise((resolve, reject) => {
    const url     = new URL(urlStr);
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port) || 80,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
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
    req.write(payload);
    req.end();
  });
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

async function main() {
  const args = process.argv.slice(2);

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
    process.exit(1);
  }
  const description = args[1] !== undefined ? args[1] : await readStdin();
  await createOne(title, description);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
