// Pure: an `OpengrepDigest` → the byte-budgeted markdown an agent actually
// reads. Groups render worst-severity-first under a hard budget with "N more …"
// tails and a drill-down pointer; a group that does not fit whole is re-rendered
// trimmed before it is cut.

import type { DigestFilter, DigestGroup, OpengrepDigest } from './digest.js';

export type RenderOptions = {
  // Hard ceiling on the rendered markdown. Groups past it are summarised.
  budgetBytes: number;
  // Per-group caps so one noisy rule cannot consume the whole budget.
  maxFilesPerGroup?: number;
  maxOccurrencesPerFile?: number;
  // Where the reader can fetch what was cut (an API URL or an MCP tool hint).
  drillDownHint?: string;
  title?: string;
  // Labels for the header.
  projectPath?: string;
  scanId?: string;
  scannedAt?: number;
  filter?: DigestFilter;
};

export const DEFAULT_DIGEST_BUDGET_BYTES = 60 * 1024;

// Snippet lines shown per fenced example before a "(+N lines)" tail.
const FENCE_MAX_LINES = 3;
// Room for the "Budget reached" line (the drill-down hint is added on top).
const BUDGET_LINE_RESERVE_BYTES = 400;
// Caps for the trimmed re-render of a group that does not fit whole.
const TRIMMED_GROUP_MAX_FILES = 3;
const TRIMMED_GROUP_MAX_OCCURRENCES = 2;
// Bounds on the "Scan caveats" section.
const CAVEAT_MAX_PARTIAL_PATHS = 15;
const CAVEAT_MAX_ERRORS = 10;

function fence(snippet: string, maxLines = FENCE_MAX_LINES): string {
  const lines = snippet.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l.trim() === ''));
  const shown = lines.slice(0, maxLines).map((l) => (l.length > 160 ? `${l.slice(0, 157)}…` : l));
  const tail = lines.length > maxLines ? `\n… (+${lines.length - maxLines} lines)` : '';
  return '```\n' + shown.join('\n') + tail + '\n```';
}

function renderGroup(g: DigestGroup, opts: RenderOptions): string {
  const maxFiles = opts.maxFilesPerGroup ?? 20;
  const maxOcc = opts.maxOccurrencesPerFile ?? 5;
  const out: string[] = [];
  const fileCount = g.files.length;
  out.push(`### ${g.severity} · \`${g.ruleId}\` — ${g.count} finding${g.count === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`);
  out.push('');
  if (g.message) out.push(g.message.length > 400 ? `${g.message.slice(0, 397)}…` : g.message);
  const meta: string[] = [];
  if (g.category) meta.push(`category: ${g.category}`);
  if (g.cwe.length) meta.push(`CWE: ${g.cwe.slice(0, 3).join('; ')}`);
  if (g.references.length) meta.push(`refs: ${g.references.slice(0, 2).join(' , ')}`);
  if (meta.length) {
    out.push('');
    out.push(`_${meta.join(' · ')}_`);
  }
  out.push('');
  let firstSnippetShown = false;
  g.files.slice(0, maxFiles).forEach((file) => {
    const occ = file.occurrences;
    const shownOcc = occ.slice(0, maxOcc);
    out.push(`- \`${file.path}\`: ${shownOcc.map((o) => `L${o.line} (fp \`${o.shortFingerprint}\`)`).join(', ')}${occ.length > maxOcc ? ` … +${occ.length - maxOcc} more in this file (same rule; narrow the digest with file=\`${file.path}\` to list them all)` : ''}`);
    if (!firstSnippetShown && shownOcc[0]?.snippet.trim()) {
      out.push('');
      out.push(`  ${file.path}:${shownOcc[0].line}`);
      out.push(fence(shownOcc[0].snippet).split('\n').map((l) => `  ${l}`).join('\n'));
      out.push('');
      firstSnippetShown = true;
    }
  });
  if (fileCount > maxFiles) {
    const rest = g.files.slice(maxFiles).reduce((n, f) => n + f.occurrences.length, 0);
    out.push(`- … ${fileCount - maxFiles} more files (${rest} findings) — see the drill-down below`);
  }
  out.push('');
  return out.join('\n');
}

function renderHeader(digest: OpengrepDigest, opts: RenderOptions): string {
  const head: string[] = [];
  head.push(`# ${opts.title ?? 'Opengrep findings'}`);
  head.push('');
  const stamp: string[] = [];
  if (opts.projectPath) stamp.push(`project: \`${opts.projectPath}\``);
  if (opts.scanId) stamp.push(`scan: \`${opts.scanId}\``);
  if (opts.scannedAt) stamp.push(`at: ${new Date(opts.scannedAt).toISOString()}`);
  if (digest.version) stamp.push(`opengrep ${digest.version}`);
  if (stamp.length) head.push(stamp.join(' · '));
  head.push('');
  head.push(
    `**${digest.shown} finding${digest.shown === 1 ? '' : 's'} shown** across ${digest.groups.length} rule${digest.groups.length === 1 ? '' : 's'} ` +
      `(${digest.bySeverity.ERROR} ERROR, ${digest.bySeverity.WARNING} WARNING, ${digest.bySeverity.INFO} INFO) · ` +
      `${digest.scannedFiles} files scanned · ${digest.total} raw findings.`,
  );
  const f = opts.filter;
  const droppedBits: string[] = [];
  if (digest.dropped.belowFloor) droppedBits.push(`${digest.dropped.belowFloor} below the ${f?.severityFloor ?? 'severity'} floor`);
  if (digest.dropped.ignoredRules) droppedBits.push(`${digest.dropped.ignoredRules} from ignored rules`);
  if (digest.dropped.ignoredFingerprints) droppedBits.push(`${digest.dropped.ignoredFingerprints} ignored by fingerprint`);
  if (digest.dropped.duplicates) droppedBits.push(`${digest.dropped.duplicates} duplicates`);
  if (droppedBits.length) head.push(`Filtered out before this digest: ${droppedBits.join(', ')}.`);
  head.push('');
  head.push(
    'Each finding carries a short fingerprint (`fp`). Fingerprints are stable across unrelated edits: ' +
      'when you file a task for a finding, put `opengrep:<fp>` on its own line in the task description and ' +
      'search the board for that marker first so a re-run does not file the same finding twice.',
  );
  head.push('');
  if (digest.groups.length === 0) {
    head.push('_No findings at or above the configured severity floor. Nothing to triage._');
    head.push('');
  }
  return head.join('\n');
}

type BudgetedSections = { sections: string[]; cutGroups: number; cutFindings: number; trimmedGroups: number };

// Every group that fits in `budget` once `reservedBytes` are set aside, whole
// or trimmed, plus a count of what was trimmed or cut.
function renderBudgetedSections(
  digest: OpengrepDigest,
  opts: RenderOptions,
  budget: number,
  reservedBytes: number,
): BudgetedSections {
  const sections: string[] = [];
  let used = reservedBytes;
  let cutGroups = 0;
  let cutFindings = 0;
  let trimmedGroups = 0;
  for (const g of digest.groups) {
    const full = renderGroup(g, opts);
    const fullSize = Buffer.byteLength(full, 'utf8');
    if (used + fullSize <= budget) {
      sections.push(full);
      used += fullSize;
      continue;
    }
    // The group does not fit whole. Groups are worst-severity-first, so
    // dropping this one while smaller, lower-severity groups still render
    // would hide exactly the findings the reader most needs. Try a trimmed
    // rendering (few files, fewer occurrences — the group's own "… N more
    // files" line points at the drill-down) before giving up on it.
    const trimmed = renderGroup(g, {
      ...opts,
      maxFilesPerGroup: TRIMMED_GROUP_MAX_FILES,
      maxOccurrencesPerFile: TRIMMED_GROUP_MAX_OCCURRENCES,
    });
    const trimmedSize = Buffer.byteLength(trimmed, 'utf8');
    if (trimmedSize < fullSize && used + trimmedSize <= budget) {
      sections.push(trimmed);
      used += trimmedSize;
      trimmedGroups += 1;
      continue;
    }
    cutGroups += 1;
    cutFindings += g.count;
  }
  return { sections, cutGroups, cutFindings, trimmedGroups };
}

function renderTail(result: BudgetedSections, budget: number, caveats: string, opts: RenderOptions): string {
  const { cutGroups, cutFindings, trimmedGroups } = result;
  const tail: string[] = [];
  if (cutGroups > 0 || trimmedGroups > 0) {
    const parts: string[] = [];
    if (trimmedGroups > 0) parts.push(`${trimmedGroups} rule${trimmedGroups === 1 ? ' is' : 's are'} listed with only a few of its files`);
    if (cutGroups > 0) parts.push(`${cutGroups} more rule${cutGroups === 1 ? '' : 's'} (${cutFindings} finding${cutFindings === 1 ? '' : 's'}) ${cutGroups === 1 ? 'was' : 'were'} left out entirely`);
    tail.push(
      `> **Budget reached:** ${parts.join('; ')} to stay under ${Math.round(budget / 1024)} KB.` +
        (opts.drillDownHint ? ` ${opts.drillDownHint}` : ''),
    );
    tail.push('');
  } else if (opts.drillDownHint) {
    tail.push(`> ${opts.drillDownHint}`);
    tail.push('');
  }
  if (caveats) tail.push(caveats);
  return tail.join('\n');
}

export function renderDigestMarkdown(digest: OpengrepDigest, opts: RenderOptions): string {
  const budget = opts.budgetBytes > 0 ? opts.budgetBytes : DEFAULT_DIGEST_BUDGET_BYTES;
  const head = renderHeader(digest, opts);

  // The caveats section is rendered FIRST so its real size is reserved from
  // the budget (it is bounded, but 15 partially-parsed paths plus 10 engine
  // errors run to several KB — a fixed reserve used to let the digest overrun).
  const caveats = renderCaveats(digest);
  const caveatsBytes = Buffer.byteLength(caveats, 'utf8');
  // Room for the "Budget reached" line + drill-down hint.
  const budgetLineReserve = BUDGET_LINE_RESERVE_BYTES + Buffer.byteLength(opts.drillDownHint ?? '', 'utf8');

  const result = renderBudgetedSections(
    digest,
    opts,
    budget,
    Buffer.byteLength(head, 'utf8') + caveatsBytes + budgetLineReserve,
  );

  return [head, ...result.sections, renderTail(result, budget, caveats, opts)].join('\n').replace(/\n{3,}/g, '\n\n');
}

function renderCaveats(digest: OpengrepDigest): string {
  if (!digest.partiallyParsed.length && !digest.errors.length && !digest.skippedRules) return '';
  const out: string[] = ['## Scan caveats', ''];
  if (digest.partiallyParsed.length) {
    const shown = digest.partiallyParsed.slice(0, CAVEAT_MAX_PARTIAL_PATHS);
    out.push(
      `- ${digest.partiallyParsed.length} file${digest.partiallyParsed.length === 1 ? ' was' : 's were'} only PARTIALLY parsed (a syntax the engine's parser does not support yet); findings in the unparsed regions are missing: ${shown.map((p) => `\`${p}\``).join(', ')}${digest.partiallyParsed.length > shown.length ? ` … +${digest.partiallyParsed.length - shown.length} more` : ''}`,
    );
  }
  if (digest.skippedRules) out.push(`- ${digest.skippedRules} rule${digest.skippedRules === 1 ? '' : 's'} skipped by the engine (unsupported features or invalid definitions).`);
  for (const e of digest.errors.slice(0, CAVEAT_MAX_ERRORS)) {
    out.push(`- ${e.level} ${e.kind}${e.path ? ` in \`${e.path}\`` : ''}: ${e.message}`);
  }
  if (digest.errors.length > CAVEAT_MAX_ERRORS) out.push(`- … +${digest.errors.length - CAVEAT_MAX_ERRORS} more errors`);
  out.push('');
  return out.join('\n');
}
