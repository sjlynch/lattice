import express, { type ErrorRequestHandler, type Express } from 'express';
// Monkey-patches Express 4 to forward async-handler rejections to the
// error middleware below, so a route that throws never returns a generic
// non-JSON 500 — the toast always has a real message to show.
import 'express-async-errors';
import cors from 'cors';
import { buildAgentActivityRouter } from '../routes/agentActivity.js';
import { buildGlobalSettingsRouter } from '../routes/globalSettings.js';
import { buildHealthRouter } from '../routes/health.js';
import { buildMergeRunsRouter } from '../routes/mergeRuns.js';
import { buildPostMergeHooksRouter } from '../routes/postMergeHooks.js';
import { buildPushRunsRouter } from '../routes/pushRuns.js';
import { buildSettingsRouter } from '../routes/settings.js';
import { buildTasksRouter } from '../routes/tasks.js';
import { buildTerminalsRouter } from '../routes/terminals.js';
import { buildWorkflowsRouter } from '../routes/workflows.js';

export type BackendAppOptions = {
  defaultRoot: string;
  backendOrigin: string;
};

export function createBackendApp(options: BackendAppOptions): Express {
  const app = express();
  mountBaseMiddleware(app);
  mountRouteFactories(app, options);
  mountJsonErrorMiddleware(app);
  return app;
}

export function mountBaseMiddleware(app: Express): void {
  app.use(cors());
  // 25mb so a Claude PreToolUse/PostToolUse hook can POST a large `Write`
  // tool_input (the whole file body) to /api/tasks/:id/activity without
  // tripping the default 100kb limit. Localhost-only personal tool; the
  // generous limit is not an exposure concern.
  app.use(express.json({ limit: '25mb' }));
  // Form-encoded bodies are dramatically easier to build from a shell than
  // JSON (no quote-escaping, no backslash gymnastics). Accepting them on
  // task-creation endpoints lets agents send `--data-urlencode title=...`
  // without reaching for jq or python. JSON is still the canonical form
  // for batch/structured payloads.
  app.use(express.urlencoded({ extended: false }));
}

export function mountRouteFactories(
  app: Express,
  options: BackendAppOptions,
): void {
  app.use(buildHealthRouter(options.defaultRoot));
  app.use(buildSettingsRouter());
  app.use(buildGlobalSettingsRouter());
  app.use(buildTerminalsRouter());
  app.use(buildTasksRouter(options.backendOrigin));
  app.use(buildAgentActivityRouter());
  app.use(buildMergeRunsRouter(options.backendOrigin));
  app.use(buildPostMergeHooksRouter());
  app.use(buildPushRunsRouter(options.backendOrigin));
  app.use(buildWorkflowsRouter(options.backendOrigin));
}

export function mountJsonErrorMiddleware(app: Express): void {
  app.use(jsonErrorMiddleware);
}

// ---------- Global JSON error middleware ----------
//
// Last route (Express convention: 4-arg handler is treated as error
// middleware). Catches:
//   - thrown sync errors from any handler
//   - rejected promises from async handlers (via express-async-errors)
//   - explicit next(err) calls
// Always responds with `{error: "..."}` so the frontend's asJson() helper
// can extract a useful message into the toast instead of falling back to
// a bare "500".
export const jsonErrorMiddleware: ErrorRequestHandler = (
  err,
  _req,
  res,
  next,
) => {
  console.error('[lattice] route error', err);
  if (res.headersSent) return next(err);
  const message =
    err instanceof Error && err.message ? err.message : String(err);
  res.status(500).json({ error: message });
};
