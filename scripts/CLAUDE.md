# Root scripts

- `orchestrate.mjs` is the `npm run dev` entrypoint. Keep it as the boot sequence only: backend first, wait for `/api/health` or timeout, then frontend.
- Orchestrator helpers live in `scripts/orchestrate/`: child spawning/prefixing/shutdown in `children.mjs`, health polling in `health.mjs`, Vite proxy ECONNREFUSED filtering in `logFilter.mjs`, shared constants/colors in `config.mjs`, and crash bookkeeping in `devLog.mjs`.
- `devLog.mjs` keeps the tail of each child's output in memory and appends it to `~/.lattice/logs/dev-runner.log` whenever a child exits abnormally. The backend and terminal-server write their own crash files (`backend/src/crashLog.ts`), but that only covers deaths they are alive to observe — a `taskkill`, an OS OOM-kill, or vite falling over leaves nothing, and `npm run dev` output lives only in the user's terminal.
- Preserve the visible dev-console contract when editing: `[backend]` / `[frontend]` prefixes and colors, Vite proxy-error suppression, and Windows `taskkill /T` process-tree shutdown.
