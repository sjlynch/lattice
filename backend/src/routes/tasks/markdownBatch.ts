// Markdown ↔ tasks grammar. Shared by /api/tasks/batch (legacy create),
// PATCH /api/tasks/:id, /append-summary, GET ?format=markdown, and
// POST /api/tasks/upsert.
//
// Grammar:
//   <!-- lattice: project=..., hash=..., status=... -->     (optional frontmatter)
//   # {id=t_abc, status=open} Title text                    (metadata block optional)
//   description body lines...
//   # Next task title
//   description...
//
// The metadata block `{key=value, ...}` accepts `,` or whitespace as the
// separator between fields. Only the first level-1 heading (`#` not `##`)
// starts a new task; subheadings inside a description are body content.
// Lines inside fenced code blocks (``` or ~~~) are body even if they look
// like headings. Lines before the first heading (after the optional
// frontmatter) are ignored.
//
// Escaping: a description line that would otherwise read as structure — a
// `# ` heading (a new task) or a fence marker that never closes (it would
// swallow every later task) — is serialized with ONE leading backslash
// (`\# Plan`, `\```js`), and the parser strips one backslash from any line
// outside a fence that matches `\*(# |```|~~~)`. Lines already starting with
// backslashes before such a marker get one more, so the mapping is exact and
// GET ?format=markdown → POST /upsert is a no-op. Documents without escapes
// parse exactly as before.
//
// Why this exists: building a JSON array of tasks with multi-line
// descriptions in a shell is brutal — every backslash, quote, and newline
// needs escaping. A heredoc with single-quoted EOF passes markdown through
// literally, no escaping at all.

export interface ParsedTaskBlock {
  /** From `{id=...}` in the heading metadata block. */
  id?: string;
  /** From `{status=...}` in the heading metadata block. */
  status?: string;
  title: string;
  description?: string;
}

export interface ParsedMarkdownDoc {
  /** From `<!-- lattice: project=... -->` frontmatter, if present. */
  project?: string;
  /** From `<!-- lattice: ... hash=... -->` frontmatter, if present. */
  hash?: string;
  tasks: ParsedTaskBlock[];
}

const FRONTMATTER_RE = /^<!--\s*lattice:\s*(.+?)\s*-->\s*$/;
// The title may be EMPTY when a metadata block is present (`# {id=t_1,
// status=done}` — a status-only edit). It used to be required, so that line
// failed the optional-metadata branch and fell back to reading the WHOLE
// `{id=…}` text as the title: an upsert then created a junk task titled
// "{id=t_1, status=done}" instead of moving t_1, and a PATCH renamed the task
// to it. A heading with neither metadata nor title (`#   `) is still body.
const HEADING_RE = /^#\s+(?:\{([^}]*)\}\s*)?(.*?)\s*$/;
const FENCE_RE = /^(?:```|~~~)/;
// A line the parser could read as structure, with any number of leading
// backslashes: escaping adds exactly one `\`, unescaping removes exactly one.
const ESCAPABLE_RE = /^\\*(?:#\s|```|~~~)/;
const ESCAPED_RE = /^\\(?=\\*(?:#\s|```|~~~))/;

function unescapeLine(line: string): string {
  return line.replace(ESCAPED_RE, '');
}

// Mirrors the parser's fence tracking over one description: headings outside
// a fence are escaped, and so is a fence opener with no later fence line to
// close it — left raw it would keep the parser in fence mode past this task's
// end, folding every later task into this description. Balanced fences stay
// raw (and their contents untouched), so code blocks read naturally.
function escapeDescription(description: string): string {
  const lines = description.split(/\r?\n/);
  let lastFence = -1;
  lines.forEach((line, i) => {
    if (FENCE_RE.test(line)) lastFence = i;
  });
  let inFence = false;
  return lines
    .map((line, i) => {
      if (inFence) {
        if (FENCE_RE.test(line)) inFence = false;
        return line;
      }
      if (FENCE_RE.test(line) && i < lastFence) {
        inFence = true;
        return line;
      }
      return ESCAPABLE_RE.test(line) ? `\\${line}` : line;
    })
    .join('\n');
}

function parseMetadataBlock(raw: string): Record<string, string> {
  // Accept `,` or whitespace as separator: `id=t_abc, status=open` or `id=t_abc status=open`.
  const out: Record<string, string> = {};
  for (const part of raw.split(/[,\s]+/)) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

export interface ParseMarkdownOptions {
  /**
   * The body describes ONE task (PATCH /api/tasks/:id): only the first
   * heading is a title, and every later `# Heading` is description content.
   * Without this a PATCH whose new description carried its own level-1
   * section headings silently lost everything after the first of them.
   */
  singleTask?: boolean;
}

export function parseMarkdownDoc(md: string, options: ParseMarkdownOptions = {}): ParsedMarkdownDoc {
  const lines = md.split(/\r?\n/);
  const doc: ParsedMarkdownDoc = { tasks: [] };
  let current: { meta: Record<string, string>; title: string; body: string[] } | null = null;
  let inFence = false;
  let sawFirstNonBlank = false;

  for (const line of lines) {
    // Optional frontmatter — only honored as the first non-blank line.
    if (!sawFirstNonBlank && line.trim()) {
      sawFirstNonBlank = true;
      const fm = FRONTMATTER_RE.exec(line);
      if (fm) {
        const fields = parseMetadataBlock(fm[1]);
        if (fields.project) doc.project = fields.project;
        if (fields.hash) doc.hash = fields.hash;
        continue;
      }
    } else if (!sawFirstNonBlank) {
      // leading blank lines: skip
      continue;
    }

    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      if (current) current.body.push(line);
      continue;
    }
    if (!inFence && !(options.singleTask && current)) {
      const h = HEADING_RE.exec(line);
      if (h && (h[1] !== undefined || h[2])) {
        if (current) doc.tasks.push(finalizeBlock(current));
        const meta = h[1] ? parseMetadataBlock(h[1]) : {};
        current = { meta, title: h[2], body: [] };
        continue;
      }
    }
    if (current) current.body.push(inFence ? line : unescapeLine(line));
    // pre-first-heading lines are dropped intentionally
  }
  if (current) doc.tasks.push(finalizeBlock(current));
  return doc;
}

function finalizeBlock(b: {
  meta: Record<string, string>;
  title: string;
  body: string[];
}): ParsedTaskBlock {
  const description = b.body.join('\n').trim();
  const out: ParsedTaskBlock = { title: b.title.trim() };
  if (b.meta.id) out.id = b.meta.id;
  if (b.meta.status) out.status = b.meta.status;
  if (description) out.description = description;
  return out;
}

// Back-compat: the original markdown-batch path only needs {title, description?}.
export function parseMarkdownTasks(md: string): Array<{ title: string; description?: string }> {
  return parseMarkdownDoc(md)
    .tasks.filter((t) => t.title)
    .map((t) => (t.description ? { title: t.title, description: t.description } : { title: t.title }));
}

export interface SerializableTask {
  id: string;
  title: string;
  description?: string;
  status: string;
}

export interface SerializeMeta {
  project?: string;
  canonicalProject?: string;
  hash?: string;
  /** Comma-joined status filter the caller passed (echoed in frontmatter). */
  statusFilter?: string;
  /**
   * Set when `limit` cut the listing short: `shown` of `matched` tasks. Emitted
   * in-band (frontmatter field + comment, both ignored by the parser) so a
   * reader of the doc can't mistake a page for the whole lane.
   */
  truncated?: { shown: number; matched: number };
}

export function serializeTasksAsMarkdown(
  tasks: SerializableTask[],
  meta?: SerializeMeta,
): string {
  const parts: string[] = [];
  const fmFields: string[] = [];
  if (meta?.canonicalProject) fmFields.push(`project=${meta.canonicalProject}`);
  if (meta?.hash) fmFields.push(`hash=${meta.hash}`);
  if (meta?.statusFilter) fmFields.push(`status=${meta.statusFilter}`);
  const truncated = meta?.truncated;
  if (truncated) fmFields.push(`truncated=${truncated.shown}/${truncated.matched}`);
  if (fmFields.length > 0) {
    parts.push(`<!-- lattice: ${fmFields.join(', ')} -->`);
    parts.push('');
    if (truncated) {
      parts.push(
        `<!-- showing ${truncated.shown} of ${truncated.matched} matching tasks (newest first) — ` +
          'pass limit=0 (or since=) for the rest -->',
      );
    }
    parts.push(
      '<!-- Edit titles/descriptions freely, then POST back to /api/tasks/upsert -->',
    );
    parts.push(
      '<!-- Headings with {id=...} update existing tasks; headings without an id create new ones -->',
    );
    parts.push('');
  }
  if (tasks.length === 0) {
    parts.push('<!-- no tasks -->');
    return parts.join('\n') + '\n';
  }
  for (const t of tasks) {
    const metaBlock = `{id=${t.id}, status=${t.status}}`;
    parts.push(`# ${metaBlock} ${t.title}`);
    if (t.description && t.description.trim()) {
      parts.push('');
      parts.push(escapeDescription(t.description.trimEnd()));
    }
    parts.push('');
  }
  return parts.join('\n');
}
