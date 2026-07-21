# Lattice

Personal coding orchestrator. Manages Claude Code agents in parallel and visualizes the active project as a 3D force graph of source files.

## Run

First time:

```
npm run install:all
```

Then:

```
npm run dev
```

This starts the backend (`127.0.0.1:5184`) and the frontend (`http://localhost:5183`) together. Open http://localhost:5183.

Ports are offset +10 from the typical Vite default (5173) to avoid collisions with other local dev servers.

## Tests

Run backend and frontend unit tests from their workspaces:

```
npm --prefix backend test
npm --prefix frontend test
```

With the normal dev server already running, run the Playwright regressions:

```
npm run test:e2e
```

The browser suite creates and removes a disposable git project under the OS
temporary directory; it does not create Lattice tasks or workflows in this
repository. Set `LATTICE_E2E_BASE_URL` to target a non-default frontend URL.

