import { Router, type Request, type Response } from 'express';
import { readProjectParam, requireExistingProjectDir } from './projectParam.js';
import { graphOfStoredScan } from '../opengrep/service.js';
import { readTriage, setFindingDisposition } from '../opengrep/triage.js';
import { cancelSecurityReview, createSharedIgnoreTask, listSecurityReviews, startSecurityReview } from '../opengrep/review.js';
import { finishReview } from '../opengrep/reviewSession.js';

export function buildOpengrepReviewRouter(backendOrigin: string) {
  const r = Router();
  const handler = (fn: (project: string, req: Request) => Promise<unknown>, write = false, query = false) => async (req: Request, res: Response) => {
    const project = readProjectParam(req, res, { source: query || !write ? 'query' : 'body' });
    if (!project) return;
    if (write && !await requireExistingProjectDir(project, res)) return;
    try { res.json(await fn(project, req)); }
    catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err), code: 'security-review' }); }
  };
  r.get('/api/opengrep/triage', handler(async (project, req) => {
    const state = await readTriage(project);
    const fp = typeof req.query.findingId === 'string' ? req.query.findingId : undefined;
    return { history: state.history.filter((e) => !fp || e.fingerprint === fp).slice(-100).reverse() };
  }));
  r.post('/api/opengrep/triage', handler(async (project, req) => {
    const graph = await graphOfStoredScan(project, typeof req.body.scanId === 'string' ? req.body.scanId : 'latest');
    const finding = graph?.allFindings.find((f) => f.fingerprint === req.body.findingId);
    if (!finding) throw new Error('Finding not found in this scan');
    if (finding.triage?.scope === 'settings' || finding.triage?.scope === 'source') throw new Error('This suppression is managed in Settings or source. Remove it there and rescan');
    return setFindingDisposition(project, finding, req.body);
  }, true));
  r.post('/api/opengrep/shared-ignore', handler((project, req) => createSharedIgnoreTask(project, req.body.scanId, req.body.findingId, req.body.reason), true));
  r.get('/api/opengrep/reviews', handler((project) => listSecurityReviews(project)));
  r.post('/api/opengrep/reviews', handler((project, req) => startSecurityReview(project, req.body, backendOrigin), true));
  r.post('/api/opengrep/reviews/:id/done', handler(async (project, req) => { await finishReview(project, String(req.params.id)); return { ok: true }; }, true, true));
  r.post('/api/opengrep/reviews/:id/cancel', handler((project, req) => cancelSecurityReview(project, String(req.params.id)), true));
  return r;
}
