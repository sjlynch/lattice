// Opengrep (SAST) endpoints: engine status/install, rule-pack install, and
// project scans + their agent-facing digests. Thin — the work is in
// `backend/src/opengrep/` (see its CLAUDE.md). Every project-scoped path goes
// through `readProjectParam`, like the rest of the router.

import { Router } from 'express';
import { canonicalProjectPath } from '../projectPath.js';
import {
  OpengrepBadTargetError,
  OpengrepInstallError,
  OpengrepNoRulesError,
  OpengrepNotInstalledError,
  OpengrepRulesBusyError,
  OpengrepScanBusyError,
  OpengrepScanFailedError,
  RulePackError,
  addOpengrepIgnores,
  digestOfStoredScan,
  findRulePackDef,
  getOpengrepStatus,
  installRulePack,
  isAnyOpengrepScanRunning,
  isRulePackInstalling,
  listOpengrepScans,
  listRulePacks,
  opengrepScanRunState,
  removeRulePack,
  scanProjectWithDigest,
  startOpengrepInstall,
  startProjectScanWithDigest,
  type DigestRenderContext,
  type OpengrepSeverity,
  type ScanWithDigestResult,
} from '../opengrep/index.js';
import { readProjectParam } from './projectParam.js';

// How long `POST /api/opengrep/scan {async: true}` waits for the scan before
// answering 202 with its id: short enough to stay far under any HTTP client's
// response timeout, long enough that a small scan comes back in one round trip.
export const ASYNC_SCAN_ACCEPT_WINDOW_MS = 15_000;

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
  if (err instanceof OpengrepBadTargetError) return { status: 400, code: 'bad-target' };
  if (err instanceof OpengrepScanBusyError) return { status: 409, code: 'busy' };
  if (err instanceof OpengrepRulesBusyError) return { status: 409, code: 'busy' };
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

  // A pack install swaps the pack directory into place and a removal deletes
  // it; both while an engine process may be reading that tree (one scan per
  // project, but several projects can scan at once). Refuse until it is idle
  // rather than hand the user a half-swapped pack or a Windows EBUSY. This is
  // the request-time fast path only: the install re-checks right before its
  // swap (waiting for running scans), and scans wait out a swap in progress
  // (`opengrep/rulesGate.ts`).
  const PACKS_BUSY = {
    error: 'An Opengrep scan is running; wait for it to finish before changing rule packs.',
    code: 'busy',
  };

  r.post('/api/opengrep/rules/install', async (req, res) => {
    const packId = str((req.body as { packId?: unknown } | undefined)?.packId);
    if (!packId || !findRulePackDef(packId)) {
      return res.status(400).json({ error: 'packId must name a known rule pack' });
    }
    if (isAnyOpengrepScanRunning()) return res.status(409).json(PACKS_BUSY);
    // Fire-and-poll like the engine install: a pack fetch is a git clone that
    // can take a while on a slow link.
    void installRulePack(packId).catch(() => {});
    res.status(202).json({ packs: await listRulePacks() });
  });

  r.delete('/api/opengrep/rules/:packId', async (req, res) => {
    const packId = String(req.params.packId);
    if (!findRulePackDef(packId)) return res.status(404).json({ error: 'unknown rule pack' });
    if (isAnyOpengrepScanRunning()) return res.status(409).json(PACKS_BUSY);
    // Removing mid-install used to be undone a moment later, when the install
    // renamed its fetched tree into place and rewrote the state entry.
    if (isRulePackInstalling(packId)) {
      return res.status(409).json({
        error: `Rule pack ${packId} is being installed; wait for the install to finish before removing it.`,
        code: 'installing',
      });
    }
    try {
      await removeRulePack(packId);
    } catch (err) {
      const m = statusFor(err);
      if (!m) throw err;
      return res.status(m.status).json({ error: (err as Error).message, code: m.code });
    }
    res.json({ packs: await listRulePacks() });
  });

  // Run a scan now with the project's configured packs + filter. Body:
  // `{project, targets?: string[], includeMarkdown?: boolean, async?: boolean}`.
  //
  // By default the response waits for the scan (the Settings button). With
  // `async: true` it waits at most ASYNC_SCAN_ACCEPT_WINDOW_MS: a scan done by
  // then answers exactly as the synchronous form does; a longer one answers
  // `202 {scanId, status: 'running'}` and is polled with GET
  // /api/opengrep/scans/:id. The MCP tool uses it — its HTTP client (undici)
  // gives up on a response after 300 s, far short of the 10 min scan cap, and
  // then told the agent Lattice was down while the scan ran on. One scan per
  // project still applies (409 `busy`) either way.
  r.post('/api/opengrep/scan', async (req, res) => {
    const project = readProjectParam(req, res);
    if (project === null) return;
    const body = (req.body ?? {}) as { targets?: unknown; includeMarkdown?: unknown; async?: unknown };
    const targets = Array.isArray(body.targets)
      ? body.targets.filter((t): t is string => typeof t === 'string' && !!t.trim())
      : undefined;
    const includeMarkdown = body.includeMarkdown === true;
    const opts = {
      targets,
      render: {
        drillDownHint:
          'Drill down with GET /api/opengrep/scans/<id>?project=&format=md&rule=<ruleId> (or the ' +
          '`opengrep_findings` MCP tool) — rule=, file= and severity= narrow the digest.',
      },
    };
    const fail = (err: unknown) => {
      const m = statusFor(err);
      if (!m) throw err;
      res.status(m.status).json({ error: (err as Error).message, code: m.code });
    };
    if (body.async !== true) {
      try {
        res.json(scanEnvelope(await scanProjectWithDigest(project, opts), includeMarkdown));
      } catch (err) {
        fail(err);
      }
      return;
    }

    const started = await startProjectScanWithDigest(project, opts).catch((err: unknown) => {
      fail(err);
      return null;
    });
    if (!started) return;
    // Settle-or-timeout. `done` is always observed here, so a scan that fails
    // after the 202 is never an unhandled rejection; the poll reports it.
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      started.done.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ASYNC_SCAN_ACCEPT_WINDOW_MS);
      }),
    ]);
    clearTimeout(timer);
    if (settled === null) {
      return res.status(202).json({
        canonicalProject: canonicalProjectPath(project),
        scanId: started.id,
        status: 'running',
        poll: `/api/opengrep/scans/${started.id}`,
      });
    }
    if ('error' in settled) return fail(settled.error);
    res.json(scanEnvelope(settled.result, includeMarkdown));
  });

  r.get('/api/opengrep/scans', async (req, res) => {
    const project = readProjectParam(req, res, { source: 'query' });
    if (project === null) return;
    const canonical = canonicalProjectPath(project);
    res.json({ canonicalProject: canonical, scans: await listOpengrepScans(canonical) });
  });

  // One stored scan (`latest` allowed). `format=md` returns the digest as
  // text/markdown; the default JSON envelope carries the digest counts and,
  // with `include=markdown`, the digest text too. The id of a scan started with
  // `async: true` that is still running answers `202 {status: 'running'}`; one
  // that failed answers the status/code its POST would have (409 `no-rules`,
  // 500 `scan-failed`, …) — both from memory, so after a backend restart the
  // id is simply unknown (404; the restart killed the engine).
  r.get('/api/opengrep/scans/:id', async (req, res) => {
    const project = readProjectParam(req, res, { source: 'query' });
    if (project === null) return;
    const id = String(req.params.id);
    const run = id === 'latest' ? null : opengrepScanRunState(project, id);
    if (run?.state === 'running') {
      return res.status(202).json({
        canonicalProject: canonicalProjectPath(project),
        scanId: id,
        status: 'running',
        startedAt: run.startedAt,
        elapsedMs: Date.now() - run.startedAt,
      });
    }
    if (run?.state === 'failed') {
      const m = statusFor(run.error) ?? { status: 500, code: 'scan-failed' };
      return res.status(m.status).json({ error: run.error.message, code: m.code, scanId: id });
    }
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

  // Append rule ids / fingerprints to the project's ignore lists. Body:
  // `{project, ruleIds?: string[], fingerprints?: string[]}` (a fingerprint
  // may be spelled with its task-marker prefix `opengrep:<fp>`). Additive and
  // deduplicated; the Settings → Tools textareas remove entries.
  r.post('/api/opengrep/ignore', async (req, res) => {
    const project = readProjectParam(req, res);
    if (project === null) return;
    const body = (req.body ?? {}) as { ruleIds?: unknown; fingerprints?: unknown };
    const ruleIds = Array.isArray(body.ruleIds) ? body.ruleIds : [];
    const fingerprints = Array.isArray(body.fingerprints) ? body.fingerprints : [];
    if (ruleIds.length === 0 && fingerprints.length === 0) {
      return res.status(400).json({ error: 'ruleIds and/or fingerprints required' });
    }
    res.json(await addOpengrepIgnores(project, { ruleIds, fingerprints }));
  });

  return r;
}
