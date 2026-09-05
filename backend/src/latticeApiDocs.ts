// Drops the agent-facing API cheatsheet into <project>/.lattice/ so AI agents
// running inside Lattice-spawned terminals can discover the HTTP API without
// any per-machine setup, harness-specific config, or pollution of the user's
// repo or shell. Agents are pointed at it by the always-on system-prompt
// preamble the backend injects at every spawn
// (harnessSystemPrompts/latticePreamble.ts), which names LATTICE_API.md by its
// absolute path.
//
// TWO files, because the preamble target is read WHOLE every time an agent is
// asked anything about Lattice:
//   - LATTICE_API.md          — a short index (~4 KB): the literal values, the
//                               board concepts, the hard rules, the
//                               cheapest-first read tiers, and five core
//                               recipes. This is the one the preamble names.
//   - LATTICE_API_RECIPES.md  — everything else (~13 KB): the full endpoint
//                               table and the batch / markdown round-trip /
//                               bulk / transition / run+merge recipes. Linked
//                               from the index via {{RECIPES_PATH}} and read
//                               only when one of those is actually needed.
//
// Conservative creation: only writes if `<project>/.lattice/` already
// exists, so non-Lattice projects (and the user's $HOME) aren't seeded
// with stray folders.
//
// Version-aware regeneration: a hash of the current content is stamped
// into the first line of each file. If the on-disk file's hash doesn't match,
// we rewrite — so existing projects pick up doc improvements on the next
// pty spawn instead of being stuck with whatever shipped first.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalProjectPath, projectHash } from './projectPath.js';

export const LATTICE_API_DOC_FILENAME = 'LATTICE_API.md';
export const LATTICE_API_RECIPES_DOC_FILENAME = 'LATTICE_API_RECIPES.md';
const LATTICE_DIR = '.lattice';
const VERSION_PREFIX = '<!-- lattice-docs-version: ';
const VERSION_SUFFIX = ' -->';

// The templates are runtime assets copied next to the compiled JS. They use
// these documented placeholders, interpolated with the LITERAL values for this
// project/port so an agent can copy them straight into a command without
// relying on any shell expansion (there is none to rely on in the default
// Windows shell, cmd.exe). `{{API_URL}}` is the required sanity probe.
const API_PORT_PLACEHOLDER = '{{API_PORT}}';
const API_URL_PLACEHOLDER = '{{API_URL}}';
const PROJECT_PLACEHOLDER = '{{PROJECT}}';
// The same project path in forward-slash form (what the doc tells agents to put
// in JSON bodies + shell), and its Lattice hash — both baked in literally so no
// recipe has to derive them at runtime.
const PROJECT_FWD_PLACEHOLDER = '{{PROJECT_FWD}}';
const PROJECT_HASH_PLACEHOLDER = '{{PROJECT_HASH}}';
// Absolute path of the sibling recipes file, so the index can hand an agent a
// path it can open directly instead of a relative hint it has to resolve.
const RECIPES_PATH_PLACEHOLDER = '{{RECIPES_PATH}}';

// We try the dist-adjacent path first, then fall back to the src tree. The
// fallback exists because a merge that introduces a new runtime asset can
// land in main before the dev runner's one-shot copy-assets has copied it
// into dist/ — without the fallback, this module crashes at import time
// (sync fs.readFileSync below) and takes the terminal-server child down
// with it, which is the failure mode we hit during a 30-task merge-all.
function templateCandidates(templateFile: string): string[] {
  return [
    fileURLToPath(new URL(`./latticeApiDocs/${templateFile}`, import.meta.url)),
    fileURLToPath(new URL(`../src/latticeApiDocs/${templateFile}`, import.meta.url)),
  ];
}

// Lazy: read a template on first ensureLatticeApiDoc call, not at module
// import. If every candidate is missing we cache `null` and disable that
// file's generation for the process lifetime, so a missing asset is a graceful
// degradation rather than a fatal import failure.
const cachedTemplates = new Map<string, string | null>();
const warnedMissing = new Set<string>();

function loadTemplate(templateFile: string): string | null {
  const cached = cachedTemplates.get(templateFile);
  if (cached !== undefined) return cached;
  const candidates = templateCandidates(templateFile);
  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = fs.readFileSync(candidate, 'utf8').replace(/\r\n?/g, '\n');
    } catch {
      continue;
    }
    if (!raw.includes(API_URL_PLACEHOLDER)) {
      console.warn(
        `[latticeApiDocs] template at ${candidate} missing ${API_URL_PLACEHOLDER} — skipping`,
      );
      continue;
    }
    cachedTemplates.set(templateFile, raw);
    return raw;
  }
  cachedTemplates.set(templateFile, null);
  if (!warnedMissing.has(templateFile)) {
    warnedMissing.add(templateFile);
    console.warn(
      `[latticeApiDocs] no template found at any of:\n  ${candidates.join(
        '\n  ',
      )}\n${templateFile} generation is disabled for this process.`,
    );
  }
  return null;
}

type DocValues = {
  apiPort: number;
  apiUrl: string;
  project: string;
  projectFwd: string;
  projectHash: string;
  recipesPath: string;
};

function renderBody(template: string, vals: DocValues): string {
  // PROJECT_FWD / PROJECT_HASH first: both contain `{{PROJECT` as a prefix, so
  // substituting the shorter PROJECT placeholder ahead of them would leave a
  // mangled `<path>_FWD}}` behind.
  return template
    .replaceAll(API_PORT_PLACEHOLDER, String(vals.apiPort))
    .replaceAll(API_URL_PLACEHOLDER, vals.apiUrl)
    .replaceAll(PROJECT_FWD_PLACEHOLDER, vals.projectFwd)
    .replaceAll(PROJECT_HASH_PLACEHOLDER, vals.projectHash)
    .replaceAll(PROJECT_PLACEHOLDER, vals.project)
    .replaceAll(RECIPES_PATH_PLACEHOLDER, vals.recipesPath);
}

function hashContent(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
}

function renderLatticeApiDoc(
  vals: DocValues,
  template: string,
): { content: string; hash: string } {
  const body = renderBody(template, vals);
  const hash = hashContent(body);
  return {
    content: `${VERSION_PREFIX}${hash}${VERSION_SUFFIX}\n${body}`,
    hash,
  };
}

function readDocVersion(content: string): string | null {
  const firstLine = content.split('\n', 1)[0];
  if (!firstLine.startsWith(VERSION_PREFIX) || !firstLine.endsWith(VERSION_SUFFIX)) {
    return null;
  }
  return firstLine
    .slice(VERSION_PREFIX.length, firstLine.length - VERSION_SUFFIX.length)
    .trim();
}

// Render + write one doc, skipping the write when the on-disk stamp already
// matches (byte-stable regeneration: no mtime churn on every pty spawn).
// Returns the path on success, null when the template is missing or the write
// failed.
function writeDoc(
  templateFile: string,
  docPath: string,
  vals: DocValues,
): string | null {
  const template = loadTemplate(templateFile);
  if (!template) return null;
  const { content, hash } = renderLatticeApiDoc(vals, template);
  try {
    if (fs.existsSync(docPath)) {
      const existing = fs.readFileSync(docPath, 'utf8');
      if (readDocVersion(existing) === hash) return docPath;
    }
  } catch {
    // fall through to write
  }
  try {
    fs.writeFileSync(docPath, content, 'utf8');
    return docPath;
  } catch {
    return null;
  }
}

// Writes both docs and returns the INDEX path — the file the system-prompt
// preamble names. A missing/unwritable recipes file degrades to "the index's
// pointer 404s", never to "the agent has no API doc at all".
export function ensureLatticeApiDoc(
  projectPath: string,
  apiPort: number,
): string | null {
  if (!projectPath) return null;
  const latticeDir = path.join(projectPath, LATTICE_DIR);
  try {
    if (!fs.existsSync(latticeDir)) return null;
  } catch {
    return null;
  }
  // Canonical project path so the literal in the doc matches what the API's
  // `canonicalProject` envelope field returns (the dir above stays on the raw
  // path to preserve existing write behavior).
  const canonical = canonicalProjectPath(projectPath);
  const vals: DocValues = {
    apiPort,
    apiUrl: `http://127.0.0.1:${apiPort}`,
    project: canonical,
    projectFwd: canonical.replace(/\\/g, '/'),
    projectHash: projectHash(canonical),
    recipesPath: path.join(canonical, LATTICE_DIR, LATTICE_API_RECIPES_DOC_FILENAME),
  };
  writeDoc(
    'LATTICE_API_RECIPES.template.md',
    path.join(latticeDir, LATTICE_API_RECIPES_DOC_FILENAME),
    vals,
  );
  return writeDoc(
    'LATTICE_API.template.md',
    path.join(latticeDir, LATTICE_API_DOC_FILENAME),
    vals,
  );
}
