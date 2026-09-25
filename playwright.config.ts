import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Lattice's dev server is user-owned (see CLAUDE.md) and the user is usually
// RUNNING it while these tests run — often with Lattice pointed at this very
// repo. Some specs create real tasks/workflows, so pointing them at the live
// :5183 would write into the user's ~/.lattice. By default the suite therefore
// boots its OWN isolated instance via `webServer`:
//   - backend  `node backend/dist/index.js` on LATTICE_E2E_BACKEND_PORT (5384)
//   - its detached terminal-server on LATTICE_E2E_TERMINAL_PORT (5385), so it
//     never shares (or idle-upgrades) the user's executor on :5185
//   - vite on LATTICE_E2E_FRONTEND_PORT (5383), proxying to that backend
//   - HOME/USERPROFILE = LATTICE_E2E_HOME (default <tmp>/lattice-e2e-home), so
//     every ~/.lattice / ~/.claude.json write lands in scratch. Kept across runs
//     on purpose: the terminal-server auth token lives there, and a previous
//     run's executor may still be draining on the same port.
// `reuseExistingServer: false` makes a port collision a hard error instead of
// silently attaching to whatever is listening.
//
// Opting into an EXISTING server: set LATTICE_E2E_BASE_URL. Targeting the live
// instance's ports (5183/5184) additionally needs LATTICE_E2E_ALLOW_LIVE=1.

const LIVE_PORTS = new Set(['5183', '5184']);
const external = process.env.LATTICE_E2E_BASE_URL;

function refuseLiveTarget(url: string): void {
  let port: string;
  try {
    const parsed = new URL(url);
    port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  } catch {
    throw new Error(`LATTICE_E2E_BASE_URL is not a URL: ${url}`);
  }
  if (LIVE_PORTS.has(port) && process.env.LATTICE_E2E_ALLOW_LIVE !== '1') {
    throw new Error(
      `Refusing to run e2e against ${url}: that is the live Lattice instance's port, and specs ` +
        'create real tasks/workflows in its ~/.lattice. Unset LATTICE_E2E_BASE_URL to let the ' +
        'suite start an isolated instance, or set LATTICE_E2E_ALLOW_LIVE=1 if you really mean it.',
    );
  }
}

const frontendPort = Number(process.env.LATTICE_E2E_FRONTEND_PORT) || 5383;
const backendPort = Number(process.env.LATTICE_E2E_BACKEND_PORT) || 5384;
const terminalPort = Number(process.env.LATTICE_E2E_TERMINAL_PORT) || 5385;

function isolatedWebServers() {
  const backendDir = path.join(__dirname, 'backend');
  if (!fs.existsSync(path.join(backendDir, 'dist', 'index.js'))) {
    throw new Error(
      'backend/dist/index.js is missing. Build the backend first (`npm --prefix backend run build`, ' +
        'or keep `npm run dev` running — its tsc -w keeps dist current).',
    );
  }
  // Set once in the runner; workers re-evaluate this file and inherit it, so
  // specs (e2e/workflow-queue cleanup) see the same scratch home.
  const home = (process.env.LATTICE_E2E_HOME ??= path.join(os.tmpdir(), 'lattice-e2e-home'));
  fs.mkdirSync(home, { recursive: true });
  const defaultRoot = path.join(home, 'default-project');
  fs.mkdirSync(defaultRoot, { recursive: true });
  const env = {
    HOME: home,
    USERPROFILE: home,
    PORT: String(backendPort),
    TERMINAL_PORT: String(terminalPort),
    LATTICE_FRONTEND_PORT: String(frontendPort),
    LATTICE_BACKEND_PORT: String(backendPort),
    // The UI's first-open project instrumentation must never write hooks for
    // THIS instance into the repo's own .claude/settings.local.json.
    LATTICE_DEFAULT_ROOT: defaultRoot,
    // Keep this vite off the live one's node_modules/.vite dep cache.
    LATTICE_VITE_CACHE_DIR: path.join(__dirname, 'frontend', 'node_modules', '.vite-e2e'),
    // Safe even from a task worktree: HOME and every port are isolated.
    LATTICE_ALLOW_WORKTREE_BACKEND: '1',
  };
  return [
    {
      command: 'node dist/index.js',
      cwd: backendDir,
      url: `http://127.0.0.1:${backendPort}/api/health`,
      env,
      reuseExistingServer: false,
      timeout: 90_000,
    },
    {
      command: 'npx vite',
      cwd: path.join(__dirname, 'frontend'),
      url: `http://localhost:${frontendPort}`,
      env,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ];
}

if (external) refuseLiveTarget(external);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: external ?? `http://localhost:${frontendPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  ...(external ? {} : { webServer: isolatedWebServers() }),
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
