// Lattice backend entry point. Wires Express, mounts route modules,
// attaches WebSocket dispatcher, and runs startup recovery before
// listening. Implementation lives in `routes/`, `ws/`, and `worktree/`.

import { installProcessGuards } from './processGuards.js';
installProcessGuards();

import express from 'express';
// Monkey-patches Express 4 to forward async-handler rejections to the
// error middleware below, so a route that throws never returns a generic
// non-JSON 500 — the toast always has a real message to show.
import 'express-async-errors';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTerminalServer } from './terminalProxy.js';
import { canonicalProjectPath } from './projectPath.js';
import { buildHealthRouter } from './routes/health.js';
import { buildSettingsRouter } from './routes/settings.js';
import { buildTerminalsRouter } from './routes/terminals.js';
import { buildTasksRouter } from './routes/tasks.js';
import { buildMergeRunsRouter } from './routes/mergeRuns.js';
import { buildPushRunsRouter } from './routes/pushRuns.js';
import { buildWorkflowsRouter } from './routes/workflows.js';
import { attachWebSockets } from './ws/wsServer.js';
import { recoverOrphanedTasks, resumeInterruptedMergeRuns } from './recovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5184;
const DEFAULT_ROOT = canonicalProjectPath(path.resolve(__dirname, '..', '..'));
const BACKEND_ORIGIN = `http://127.0.0.1:${PORT}`;

const app = express();
app.use(cors());
app.use(express.json());
// Form-encoded bodies are dramatically easier to build from a shell than
// JSON (no quote-escaping, no backslash gymnastics). Accepting them on
// task-creation endpoints lets agents send `--data-urlencode title=...`
// without reaching for jq or python. JSON is still the canonical form
// for batch/structured payloads.
app.use(express.urlencoded({ extended: false }));

app.use(buildHealthRouter(DEFAULT_ROOT));
app.use(buildSettingsRouter());
app.use(buildTerminalsRouter());
app.use(buildTasksRouter(BACKEND_ORIGIN));
app.use(buildMergeRunsRouter(BACKEND_ORIGIN));
app.use(buildPushRunsRouter(BACKEND_ORIGIN));
app.use(buildWorkflowsRouter(BACKEND_ORIGIN));

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
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    console.error('[lattice] route error', err);
    if (res.headersSent) return next(err);
    const message =
      err instanceof Error && err.message ? err.message : String(err);
    res.status(500).json({ error: message });
  },
);

const server = http.createServer(app);
attachWebSockets(server);

async function start() {
  await ensureTerminalServer();
  await recoverOrphanedTasks();
  server.listen(PORT, () => {
    console.log(`[lattice-backend] listening on http://localhost:${PORT}`);
    console.log(`[lattice-backend] default root: ${DEFAULT_ROOT}`);
    // Now that the API is up, resume any merge run a previous process was
    // running when it got restarted (resolver Claudes it may spawn need
    // the API listening to call back).
    resumeInterruptedMergeRuns(BACKEND_ORIGIN).catch((err) =>
      console.error('[startup] resumeInterruptedMergeRuns failed:', err),
    );
  });
}

start().catch((err) => {
  console.error('[lattice-backend] startup error:', err);
  process.exit(1);
});
