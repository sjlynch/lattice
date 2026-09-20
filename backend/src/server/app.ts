import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from 'express';
// Monkey-patches Express 4 to forward async-handler rejections to the
// error middleware below, so a route that throws never returns a generic
// non-JSON 500 — the toast always has a real message to show.
import 'express-async-errors';
import cors from 'cors';
import { buildAgentActivityRouter } from '../routes/agentActivity.js';
import { buildProjectClaudeRouter } from '../routes/projectClaude.js';
import { buildGlobalSettingsRouter } from '../routes/globalSettings.js';
import { buildHealthRouter } from '../routes/health.js';
import { buildMcpRouter } from '../routes/mcp.js';
import { buildMergeRunsRouter } from '../routes/mergeRuns.js';
import { buildPostMergeHooksRouter } from '../routes/postMergeHooks.js';
import { buildProjectInitRouter } from '../routes/projectInit.js';
import { buildPushRunsRouter } from '../routes/pushRuns.js';
import { buildQaRunsRouter } from '../routes/qaRuns.js';
import { buildSearchRouter } from '../routes/search.js';
import { buildSettingsRouter } from '../routes/settings.js';
import { buildTasksRouter } from '../routes/tasks.js';
import { buildTerminalsRouter } from '../routes/terminals.js';
import { buildTerminalTabsRouter } from '../routes/terminalTabs.js';
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

// The SPA is same-origin via vite's dev-server proxy and never relies on
// CORS response headers, so a strict allowlist is invisible to the app while
// blocking cross-origin attackers. Only the vite dev origin (both loopback
// spellings) is permitted. curl/agent task-seeding is unaffected because those
// requests send no Origin header.
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5183',
  'http://127.0.0.1:5183',
]);

function isAllowedOrigin(origin: string | undefined): boolean {
  return !origin || ALLOWED_ORIGINS.has(origin);
}

// Reject any cross-origin request — one carrying a present, non-allowlisted
// Origin header. Same-origin browser requests, curl, and server-side hooks send
// no Origin (or the allowlisted vite origin) and pass untouched.
//
// This deliberately covers "safe" methods (GET/HEAD) too, not just POST: our
// GET endpoints do real work — `/api/search` runs a user-supplied regex over
// every source file, and `/api/scan` walks an attacker-chosen filesystem path —
// so a drive-by page's `fetch(url, { mode: 'no-cors' })` must be blocked from
// triggering them cross-origin (the browser hides the opaque response, but the
// server still burns the CPU/IO otherwise). OPTIONS preflight is handled by the
// cors() layer above and is exempt so it can complete normally.
export const rejectDisallowedUnsafeOrigin: RequestHandler = (req, res, next) => {
  const origin = req.get('origin');
  if (req.method !== 'OPTIONS' && !isAllowedOrigin(origin)) {
    return res.status(403).json({ error: 'origin not allowed' });
  }
  next();
};

export function mountBaseMiddleware(app: Express): void {
  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header (same-origin requests, curl, server-side hooks)
        // → allow; cross-origin requests must match the allowlist.
        if (!origin || ALLOWED_ORIGINS.has(origin)) {
          callback(null, true);
        } else {
          callback(null, false);
        }
      },
    }),
  );
  // CORS alone only withholds response headers; it does not stop a malicious
  // page from submitting a simple form POST or a drive-by no-cors GET. Reject
  // any cross-origin request before a body parser or route handler can perform
  // side effects or burn CPU/IO on the attacker's behalf.
  app.use(rejectDisallowedUnsafeOrigin);
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
  app.use(buildSearchRouter(options.defaultRoot));
  app.use(buildSettingsRouter());
  app.use(buildGlobalSettingsRouter());
  app.use(buildMcpRouter());
  // Both paths are static (no `:param` segment), so nothing later can shadow
  // them and they shadow nothing.
  app.use(buildProjectInitRouter());
  app.use(buildTerminalsRouter());
  app.use(buildTerminalTabsRouter());
  app.use(buildTasksRouter(options.backendOrigin));
  app.use(buildAgentActivityRouter());
  app.use(buildProjectClaudeRouter(options.backendOrigin));
  app.use(buildMergeRunsRouter(options.backendOrigin));
  app.use(buildPostMergeHooksRouter());
  app.use(buildPushRunsRouter(options.backendOrigin));
  app.use(buildQaRunsRouter(options.backendOrigin));
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
const requestBodyErrors = new Map<string, { status: number; message: string }>([
  ['entity.parse.failed', {
    status: 400,
    message: 'Invalid JSON request body. Use a JSON serializer to escape backslashes, quotes, and newlines. Task summaries also accept text/markdown with --data-binary @file.',
  }],
  ['entity.too.large', { status: 413, message: 'Request body exceeds the allowed size.' }],
  ['parameters.too.many', { status: 413, message: 'Request body contains too many form parameters.' }],
  ['charset.unsupported', { status: 415, message: 'Unsupported request body charset. Use UTF-8.' }],
  ['encoding.unsupported', { status: 415, message: 'Unsupported request body content encoding.' }],
  ['entity.verify.failed', { status: 403, message: 'Request body verification failed.' }],
  ['request.aborted', { status: 400, message: 'Request body was interrupted before it finished.' }],
  ['request.size.invalid', { status: 400, message: 'Request body length does not match Content-Length.' }],
]);

export const jsonErrorMiddleware: ErrorRequestHandler = (
  err,
  req,
  res,
  next,
) => {
  // Body-parser attaches the original body to parse errors; logging the whole
  // error dumps potentially large/private summaries into crash mirrors. These
  // are rejected requests, not server failures. Keep their documented 4xx
  // status and log only bounded routing metadata, never the body or an error
  // message that may itself quote submitted content.
  const type = err && typeof err.type === 'string' ? err.type : undefined;
  const bodyError = type ? requestBodyErrors.get(type) : undefined;
  if (bodyError) {
    console.warn('[lattice] rejected request body', {
      method: req.method, path: req.path.slice(0, 256), status: bodyError.status, type,
    });
    if (res.headersSent) return next(err);
    res.status(bodyError.status).json({ error: bodyError.message, code: type });
    return;
  }
  console.error('[lattice] route error', err);
  if (res.headersSent) return next(err);
  const message =
    err instanceof Error && err.message ? err.message : String(err);
  res.status(500).json({ error: message });
};
