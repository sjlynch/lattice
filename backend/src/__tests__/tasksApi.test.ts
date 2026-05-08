import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdownTasks } from '../routes/tasks.js';

// ---------- parseMarkdownTasks ----------
//
// The parser is the single most LLM-facing piece of new code: agents
// hand it markdown verbatim, and any quirk here means tasks land in
// the wrong shape (or not at all). Cover the cases an LLM is most
// likely to produce — multi-line descriptions, code fences, mixed
// quotes, leading/trailing blank lines, the works.

test('parseMarkdownTasks: empty input', () => {
  assert.deepEqual(parseMarkdownTasks(''), []);
  assert.deepEqual(parseMarkdownTasks('\n\n\n'), []);
});

test('parseMarkdownTasks: ignores text before the first heading', () => {
  const md = `Some preamble we should drop.
Another preamble line.

# First task
Body of first task.`;
  assert.deepEqual(parseMarkdownTasks(md), [
    { title: 'First task', description: 'Body of first task.' },
  ]);
});

test('parseMarkdownTasks: single task with no body', () => {
  assert.deepEqual(parseMarkdownTasks('# Title only'), [{ title: 'Title only' }]);
});

test('parseMarkdownTasks: multiple tasks, multi-line bodies', () => {
  const md = `# Task A
Line 1
Line 2

Line 4 after blank

# Task B
Just one line`;
  assert.deepEqual(parseMarkdownTasks(md), [
    { title: 'Task A', description: 'Line 1\nLine 2\n\nLine 4 after blank' },
    { title: 'Task B', description: 'Just one line' },
  ]);
});

test('parseMarkdownTasks: preserves quotes and backslashes in descriptions', () => {
  const md = `# Refactor
Has "quoted text" and \\backslashes\\ — should be literal.
Path: F:\\rust_etl\\src\\foo.rs`;
  const out = parseMarkdownTasks(md);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Refactor');
  assert.equal(
    out[0].description,
    `Has "quoted text" and \\backslashes\\ — should be literal.\nPath: F:\\rust_etl\\src\\foo.rs`,
  );
});

test('parseMarkdownTasks: keeps ## subheadings inside descriptions', () => {
  const md = `# Outer task
Intro paragraph.

## Subheading inside description
More body text.

# Next task
Body B`;
  const out = parseMarkdownTasks(md);
  assert.equal(out.length, 2);
  assert.equal(
    out[0].description,
    'Intro paragraph.\n\n## Subheading inside description\nMore body text.',
  );
  assert.equal(out[1].title, 'Next task');
});

test('parseMarkdownTasks: handles CRLF line endings', () => {
  const md = '# CRLF task\r\nLine 1\r\nLine 2\r\n\r\n# Another\r\nBody';
  assert.deepEqual(parseMarkdownTasks(md), [
    { title: 'CRLF task', description: 'Line 1\nLine 2' },
    { title: 'Another', description: 'Body' },
  ]);
});

test('parseMarkdownTasks: trims whitespace around title and description block edges', () => {
  const md = `#    Spaced title
  Indented body line
trailing space line

# Next`;
  const out = parseMarkdownTasks(md);
  assert.equal(out[0].title, 'Spaced title');
  // Title trim is unconditional; description trim runs once on the
  // joined block, so it strips whitespace at the very start/end (incl.
  // the leading indent on the first body line) but preserves internal
  // indentation between lines.
  assert.equal(
    out[0].description,
    'Indented body line\ntrailing space line',
  );
});

test('parseMarkdownTasks: drops empty-titled headings', () => {
  // `# ` alone (just a hash + space) has no captured title, so the
  // regex doesn't match and the line stays in the previous task's
  // description. `#` with trailing whitespace is similar — the regex
  // requires at least one non-whitespace character after the space.
  const md = `# Real
body
#
not a task heading`;
  const out = parseMarkdownTasks(md);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Real');
});

test('parseMarkdownTasks: only top-level # creates a task', () => {
  const md = `# Top
body
## Not a new task
still part of top
### Nor this
also part`;
  const out = parseMarkdownTasks(md);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Top');
  assert.match(out[0].description!, /## Not a new task/);
  assert.match(out[0].description!, /### Nor this/);
});

test('parseMarkdownTasks: realistic LLM-style batch (8 tasks, mixed bodies)', () => {
  // Mirrors the shape of the seed_review_tasks.py the agent wrote in
  // the wild — 8 tasks with structured multi-line descriptions.
  const md = `# Resolve readme.md merge-conflict markers
Lines 418, 471-598 still have <<<<<<</>>>>>>> markers from a prior merge.
Reconcile both sections and ensure the docs reflect the current code.

# Refactor PartitionWriters concurrency contract
Doc claims "concurrency-friendly" but write_with takes &mut self,
preventing real cross-thread use. Either:
- Change to &self (sound, since each partition is already Mutex<...>)
- Or strip the docs and per-partition mutexes (former preferred).

# Surface UsernameStream file-open errors
next() calls self.open_next().ok()? — a permission-denied or I/O error
on file N becomes "stream is empty," indistinguishable from genuine end.

# Replace global Mutex<MemState> with AtomicU64
Under heavy parallelism each worker contends every 4096 lines.
Switch to a fixed-point fraction in an AtomicU64.

# Upgrade sysinfo to 0.30+
mem.rs uses the deprecated 0.29 SystemExt import. 0.30+ removed the
trait. Pin & document or upgrade.

# Add streaming JSON tokenizer for whitelist export
streaming::stream_job falls back to serde_json::from_str for any
whitelist, dominating CPU. A purpose-built tokenizer would unlock
5–10× faster exports.

# Track resumable-run progress
extract_spool_monthly sweeps stale .inprogress on entry but doesn't
record which months succeeded. A small _progress.json next to outputs
would let crashed runs skip already-complete months.

# Add criterion benches for inner loops
cargo bench against for_each_line_cfg, matches_minimal,
rewrite_human_timestamps_bytes — defends against perf regressions in
review.`;
  const out = parseMarkdownTasks(md);
  assert.equal(out.length, 8, `expected 8 tasks, got ${out.length}`);
  assert.equal(out[0].title, 'Resolve readme.md merge-conflict markers');
  assert.equal(out[7].title, 'Add criterion benches for inner loops');
  // Spot-check the mid-task with quoted strings
  assert.match(out[1].description!, /"concurrency-friendly"/);
  // List items survive
  assert.match(out[1].description!, /- Change to &self/);
});
