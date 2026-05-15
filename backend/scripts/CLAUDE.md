# Backend scripts

- `dev.mjs` is the backend dev-runner entrypoint. Keep it readable as: self-heal deps → initial compile/assets → start `tsc -w` → spawn backend → watch `dist/` → wire shutdown.
- Focused helpers live under `backend/scripts/dev/`: dependency/npm helpers, compile/assets orchestration, run.lock restart deferral, dist watching, and backend/terminal lifecycle.
- Preserve the dev-runner contract: exact log messages, copy assets before every backend spawn, defer restarts while live per-project `run.lock` files exist (with the max-defer backstop), and call terminal-server `/shutdown` only during real shutdown.
