# frontend/src/api

Backend bindings, grouped by domain. `import { ... } from '../api'` resolves to `index.ts` here.

## Modules

- `types/` — domain-split shared API types (scan/health, settings, tasks, workflows, runs, git history). `types.ts` is a compatibility re-export shim.
- `http.ts` — `asJson<T>(r)` extracts `{error}` from non-2xx responses so toasts get real messages.
- `ws.ts` — `subscribeWs<T>(pathWithQuery, onMessage)`. Auto-reconnects with exponential backoff (cap 5 s). Every WS subscriber here uses it.
- `scan.ts` — folder browsing + recursive source scan.
- `settings.ts` — per-project `UserSettings`.
- `tasks.ts` — task CRUD + `runTask`, `resumeTask`, `mergeTask`, `subscribeTasks`.
- `mergeRuns.ts` — `startMergeRun`, `getActiveMergeRun`, `cancelMergeRun`, `subscribeMergeRuns`.
- `workflows.ts` — workflow CRUD + `startWorkflow`, `subscribeWorkflows`, `subscribeWorkflowRuns`.

## Adding an endpoint

1. Type goes in the matching `types/<domain>.ts` file, and is re-exported by `types/index.ts`.
2. Function goes in the matching domain file. Use `asJson` for non-WS calls.
3. WS endpoints: call `subscribeWs(path, cb)` directly — don't reinvent reconnect/backoff.
4. New domains: add a file + add `export *` to `index.ts`.
