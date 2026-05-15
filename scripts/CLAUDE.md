# Root scripts

- `orchestrate.mjs` is the `npm run dev` entrypoint. Keep it as the boot sequence only: backend first, wait for `/api/health` or timeout, then frontend.
- Orchestrator helpers live in `scripts/orchestrate/`: child spawning/prefixing/shutdown in `children.mjs`, health polling in `health.mjs`, Vite proxy ECONNREFUSED filtering in `logFilter.mjs`, shared constants/colors in `config.mjs`.
- Preserve the visible dev-console contract when editing: `[backend]` / `[frontend]` prefixes and colors, Vite proxy-error suppression, and Windows `taskkill /T` process-tree shutdown.
