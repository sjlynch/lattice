// Drops a single markdown cheatsheet into <project>/.lattice/LATTICE_API.md
// so AI agents running inside Lattice-spawned terminals can discover the
// HTTP API without any per-machine setup, harness-specific config, or
// pollution of the user's repo or shell. The terminal-server points
// $LATTICE_DOCS at this file so the agent can `cat $LATTICE_DOCS` whenever
// the user mentions Lattice / tasks / merging.
//
// Conservative creation: only writes if `<project>/.lattice/` already
// exists, so non-Lattice projects (and the user's $HOME) aren't seeded
// with stray folders.
//
// Version-aware regeneration: a hash of the current content is stamped
// into the first line. If the on-disk file's hash doesn't match, we
// rewrite — so existing projects pick up doc improvements on the next
// pty spawn instead of being stuck with whatever shipped first.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LATTICE_API_DOC_FILENAME = 'LATTICE_API.md';
const LATTICE_DIR = '.lattice';
const VERSION_PREFIX = '<!-- lattice-docs-version: ';
const VERSION_SUFFIX = ' -->';

// LATTICE_API.template.md is a runtime asset copied next to the compiled JS.
// It uses this documented placeholder where the current API port should appear.
const API_PORT_PLACEHOLDER = '{{API_PORT}}';

// We try the dist-adjacent path first, then fall back to the src tree. The
// fallback exists because a merge that introduces a new runtime asset can
// land in main before the dev runner's one-shot copy-assets has copied it
// into dist/ — without the fallback, this module crashes at import time
// (sync fs.readFileSync below) and takes the terminal-server child down
// with it, which is the failure mode we hit during a 30-task merge-all.
const TEMPLATE_CANDIDATES = [
  fileURLToPath(new URL('./latticeApiDocs/LATTICE_API.template.md', import.meta.url)),
  fileURLToPath(new URL('../src/latticeApiDocs/LATTICE_API.template.md', import.meta.url)),
];

// Lazy: read the template on first ensureLatticeApiDoc call, not at module
// import. If every candidate is missing we cache `null` and disable doc
// generation for the process lifetime, so a missing asset is a graceful
// degradation rather than a fatal import failure.
let cachedTemplate: string | null | undefined;
let warnedMissing = false;

function loadTemplate(): string | null {
  if (cachedTemplate !== undefined) return cachedTemplate;
  for (const candidate of TEMPLATE_CANDIDATES) {
    let raw: string;
    try {
      raw = fs.readFileSync(candidate, 'utf8').replace(/\r\n?/g, '\n');
    } catch {
      continue;
    }
    if (!raw.includes(API_PORT_PLACEHOLDER)) {
      console.warn(
        `[latticeApiDocs] template at ${candidate} missing ${API_PORT_PLACEHOLDER} — skipping`,
      );
      continue;
    }
    cachedTemplate = raw;
    return cachedTemplate;
  }
  cachedTemplate = null;
  if (!warnedMissing) {
    warnedMissing = true;
    console.warn(
      `[latticeApiDocs] no template found at any of:\n  ${TEMPLATE_CANDIDATES.join(
        '\n  ',
      )}\nLATTICE_API.md generation is disabled for this process.`,
    );
  }
  return null;
}

function renderBody(apiPort: number, template: string): string {
  return template.replaceAll(API_PORT_PLACEHOLDER, String(apiPort));
}

function hashContent(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
}

function renderLatticeApiDoc(
  apiPort: number,
  template: string,
): { content: string; hash: string } {
  const body = renderBody(apiPort, template);
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

export function ensureLatticeApiDoc(
  projectPath: string,
  apiPort: number,
): string | null {
  if (!projectPath) return null;
  const template = loadTemplate();
  if (!template) return null;
  const latticeDir = path.join(projectPath, LATTICE_DIR);
  try {
    if (!fs.existsSync(latticeDir)) return null;
  } catch {
    return null;
  }
  const docPath = path.join(latticeDir, LATTICE_API_DOC_FILENAME);
  const { content, hash } = renderLatticeApiDoc(apiPort, template);
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
