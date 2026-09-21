// Opengrep (SAST) endpoints: engine status/install, rule-pack install, and
// project scans + their agent-facing digests. Thin — the work is in
// `backend/src/opengrep/` (see its CLAUDE.md). Every project-scoped path goes
// through `readProjectParam`, like the rest of the router.

import { Router } from 'express';
import { canonicalProjectPath } from '../projectPath.js';
import {
  OpengrepInstallError,
  OpengrepNoRulesError,
  OpengrepNotInstalledError,
  OpengrepScanBusyError,
  OpengrepScanFailedError,
  RulePackError,
  digestOfStoredScan,
  findRulePackDef,
  getOpengrepStatus,
  installRulePack,
  listOpengrepScans,
  listRulePacks,
  removeRulePack,
  scanProjectWithDigest,
  startOpengrepInstall,
  type DigestRenderContext,
  type OpengrepSeverity,
  type ScanWithDigestResult,
} from '../opengrep/index.js';
import { readProjectParam } from './projectParam.js';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function renderContextFromQuery(q: Record<string, unknown>): DigestRenderContext {
  const ctx: DigestRenderContext = {};
  const rule = str(q.rule);
  const file = str(q.file);
  if (rule) ctx.rule = rule;
  if (file) ctx.file = file;
  const sev = str(q.severity)?.toUpperCase();
  if (sev === 'ERROR' || sev === 'WARNING' || sev === 'INFO') {
    ctx.filter = { severityFloor: sev as OpengrepSeverity };
  }
  const kb = Number(q.budgetKb);
  if (Number.isFinite(kb) && kb >= 8) ctx.budgetBytes = Math.min(2048, Math.floor(kb)) * 1024;
  return ctx;
}

// A scan's JSON envelope: the record, the digest's counts, and (optionally) the
// markdown, plus `canonicalProject` so the MCP client's project assertion
// holds.
function scanEnvelope(r: ScanWithDigestResult, includeMarkdown: boolean) {
  return {
    canonicalProject: r.record.project,
    scan: r.record,
    digest: {
      shown: r.digest.shown,
      total: r.digest.total,
      bySeverity: r.digest.bySeverity,
      rules: r.digest.groups.length,
      dropped: r.digest.dropped,
      partiallyParsed: r.digest.partiallyParsed.length,
      errors: r.digest.errors.length,
      bytes: Buffer.byteLength(r.markdown, 'utf8'),
    },
    filter: r.config.filter,
    ...(includeMarkdown ? { markdown: r.markdown } : {}),
  };
}

function statusFor(err: unknown): { status: number; code: string } | null {
  if (err instanceof OpengrepScanBusyError) return { status: 409, code: 'busy' };
  if (err instanceof OpengrepNotInstalledError) return { status: 409, code: 'not-installed' };
  if (err instanceof OpengrepNoRulesError) return { status: 409, code: 'no-rules' };
  if (err instanceof OpengrepScanFailedError) return { status: 500, code: 'scan-failed' };
  if (err instanceof OpengrepInstallError) return { status: 409, code: 'install-failed' };
  if (err instanceof RulePackError) return { status: 500, code: 'rule-pack-failed' };
  return null;
}

export function buildOpengrepRouter(): Router {
  const r = Router();

  r.get('/api/opengrep/status', async (req, res) => {
    const project = readProjectParam(req, res, { source: 'query', optional: true });
    if (project === null) return;
    res.json(await getOpengrepStatus(project || undefined));
  });

  // Start the managed engine install (single-flight; returns the running job
  // when one is in progress). Poll /status for progress.
  r.post('/api/opengrep/install', async (_req, res) => {
    try {
      res.status(202).json({ job: await startOpengrepInstall() });
    } catch (err) {
      const m = statusFor(err);
      if (!m) throw err;
      res.status(m.status).json({ error: (err as Error).message, code: m.code });
    }
  });

  r.post('/api/opengrep/rules/install', async (req, res) => {
    const packId = str((req.body as { packId?: unknown } | undefined)?.packId);
    if (!packId || !findRulePackDef(packId)) {
      return res.status(400).json({ error: 'packId must name a known rule pack' });
    }
    // Fire-and-poll like the engine install: a pack fetch is a git clone that
    // can take a while on a slow link.
    void installRulePack(packId).catch(() => {});
    res.status(202).json({ packs: await listRulePacks() });
  });

  r.delete('/api/opengrep/rules/:packId', async (req, res) => {
    const packId = String(req.params.packId);
    if (!findRulePackDef(packId)) return res.status(404).json({ error: 'unknown rule pack' });
    await removeRulePack(packId);
    res.json({ packs: await listRulePacks() });
  });

  // Run a scan now with the project's configured packs + filter. Body:
  // `{project, targets?: string[], includeMarkdown?: boolean}`.
  r.post('/api/opengrep/scan', async (req, res) => {
    const project = readProjectParam(req, res);
    if (project === null) return;
    const body = (req.body ?? {}) as { targets?: unknown; includeMarkdown?: unknown };
    const targets = Array.isArray(body.targets)
      ? body.targets.filter((t): t is string => typeof t === 'string' && !!t.trim())
      : undefined;
    try {
      const result = await scanProjectWithDigest(project, {
        targets,
        render: {
          drillDownHint:
            'Drill down with GET /api/opengrep/scans/<id>?project=&format=md&rule=<ruleId> (or the ' +
            '`opengrep_findings` MCP tool) — rule=, file= and severity= narrow the digest.',
        },
      });
      res.json(scanEnvelope(result, body.includeMarkdown === true));
    } catch (err) {
      const m = statusFor(err);
      if (!m) throw err;
      res.status(m.status).json({ error: (err as Error).message, code: m.code });
    }
  });

  r.get('/api/opengrep/scans', async (req, res) => {
    const project = readProjectParam(req, res, { source: 'query' });
    if (project === null) return;
    const canonical = canonicalProjectPath(project);
    res.json({ canonicalProject: canonical, scans: await listOpengrepScans(canonical) });
  });

  // One stored scan (`latest` allowed). `format=md` returns the digest as
  // text/markdown; the default JSON envelope carries the digest counts and,
  // with `include=markdown`, the digest text too.
  r.get('/api/opengrep/scans/:id', async (req, res) => {
    const project = readProjectParam(req, res, { source: 'query' });
    if (project === null) return;
    const id = String(req.params.id);
    const ctx = renderContextFromQuery(req.query as Record<string, unknown>);
    ctx.drillDownHint ??=
      'Narrow this digest with rule=<ruleId>, file=<path>, severity=INFO|WARNING|ERROR or budgetKb=<n> on the same URL.';
    const result = await digestOfStoredScan(project, id === 'latest' ? undefined : id, ctx);
    if (!result) return res.status(404).json({ error: `no Opengrep scan ${id} for this project` });
    const format = str((req.query as Record<string, unknown>).format);
    if (format === 'md' || format === 'markdown') {
      res.type('text/markdown; charset=utf-8').send(result.markdown);
      return;
    }
    const include = str((req.query as Record<string, unknown>).include);
    res.json(scanEnvelope(result, include === 'markdown'));
  });

  return r;
}
