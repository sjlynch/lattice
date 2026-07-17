# frontend/src/api

Backend bindings, grouped by domain. `import { ... } from '../api'` resolves to `index.ts` here.

## Modules

- `types/` — domain-split shared API types (scan/health, settings, tasks, workflows, runs, git history). `types.ts` is a compatibility re-export shim.
- `http.ts` — `asJson<T>(r)` extracts `{error}` from non-2xx responses so toasts get real messages; `postJson`/`patchJson`/`deleteJson` centralize JSON request formation.
- `ws.ts` — `subscribeWs<T>(pathWithQuery, onMessage)`. Auto-reconnects with exponential backoff (cap 5 s). Every WS subscriber here uses it.
- `scan.ts` — folder browsing + recursive source scan; git history/branch helpers, incl. `subscribeGitBranch(project, cb)` (the `/ws/git-branch` live navbar-chip stream — pushes the branch on connect + on every checkout) and `subscribeGitStatus(project, cb)` (the `/ws/git-status` stream — pushes a compact status signature on connect + whenever a commit/edit changes it, so the timeline scrubber can live-refresh `fetchGitHistory`, deduping on `GitHistoryResult.signature`).
- `health.ts` — `subscribeHealth(project, cb)`: the `/ws/health` `HealthUpdate` stream (one per file save / tree change).
- `settings.ts` — per-project `UserSettings`.
- `globalSettings.ts` — machine-global settings (`maxConcurrentAgents`, MCP custom/override defs, `piModelMenu`, `piProviders`): `fetchGlobalSettings`, `patchGlobalSettings`.
- `mcp.ts` — MCP control-plane: `fetchMcpCatalog`, redacted-secret get/set (`fetchMcpSecrets`/`setMcpSecret`), `fetchMcpEnvPresence`, `validateMcpServer`, and other-tool import `scanMcpImport`/`applyMcpImport`. Raw secret values never cross this boundary.
- `tasks.ts` — task CRUD + `runTask`, `resumeTask`, `mergeTask`, `subscribeTasks`.
- `mergeRuns.ts` — `startMergeRun`, `getActiveMergeRun`, `cancelMergeRun`, `subscribeMergeRuns`.
- `workflows.ts` — workflow CRUD + `startWorkflow`, prompt-customization start/status helpers, `subscribeWorkflows`, `subscribeWorkflowRuns`.
- `pushRuns.ts` — push-run lifecycle (commit + push the project via a Claude session): `checkGit`, `startPushRun`, `fetchPushRunStatus`, `forgetPushRun`.
- `qaRuns.ts` — QA e2e-run lifecycle (Playwright Claude over one merged task; mirrors `pushRuns`): `startQaRun`, `fetchQaRunStatus`, `forgetQaRun`.
- `postMergeHooks.ts` — post-merge hook run state: `getActivePostMergeHook`, `abortPostMergeHook`, `subscribePostMergeHooks`.

## Adding an endpoint

1. Type goes in the matching `types/<domain>.ts` file, and is re-exported by `types/index.ts`.
2. Function goes in the matching domain file. Use `asJson` for simple GETs and `postJson`/`patchJson`/`deleteJson` for JSON writes.
3. WS endpoints: call `subscribeWs(path, cb)` directly — don't reinvent reconnect/backoff.
4. New domains: add a file + add `export *` to `index.ts`.
