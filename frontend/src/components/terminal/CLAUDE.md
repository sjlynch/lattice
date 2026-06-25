# frontend/src/components/terminal

The xterm UI + WS-connection hooks behind `../TerminalPane.tsx` (which is just
`useRef`s wired into these three hooks). This is the *view/connection* layer;
the tab-list state/storage/pty-DELETE logic lives in `../../terminal/` (its own
CLAUDE.md) — different directory, don't conflate.

- `useTerminalLifecycle.ts` — creates/disposes the `Terminal` + `FitAddon` and
  a `ResizeObserver`. Does **not** attach the WebglAddon.
- `useActiveTerminalWebgl.ts` — attaches a `WebglAddon` only while this pane is
  `active`, disposes it on deactivate. Each WebGL context counts toward Chrome's
  ~16-per-page cap; holding one per terminal made "Run All" blow past it.
- `useTerminalConnection.ts` — the `/ws/terminal` WebSocket: connect, replay,
  input/resize forwarding, reconnect. Owns the connection *state machine*
  (`terminated` / `attachedOnce` / `attempt`) and the React effect; holds the
  invariants below. The protocol *mechanism* lives in `terminalSocket.ts`.
- `terminalSocket.ts` — React-free helpers for the connection: `buildTerminalWsUrl`
  (URL building), `handleTerminalMessage` (decode + dispatch), `reconnectDelay` /
  `canReattachTerminal` / `shouldGiveUpReconnect` (backoff/give-up decisions),
  `forwardTerminalInput` (xterm onData/onResize → socket), `terminalNotices` (all
  user-visible terminal-body status lines, in one place), and `MAX_RECONNECT_ATTEMPTS`.
- `terminalConfig.ts` — `Terminal` options + theme. `clipboardPaste.ts` — Ctrl+V
  → `term.paste()` (xterm would otherwise forward ^V as a raw byte).

## Load-bearing invariants in `useTerminalConnection.ts`

These look like accidents and are not — each fixes a specific past incident.
Don't "clean them up" without resurrecting the bug.

- **`setTimeout(connect, 0)` is required, not a smell** (~L185). It defers the
  WS open by one task tick so React StrictMode's synchronous cleanup (which sets
  `cancelled = true`) runs *before* the handshake starts. Connect synchronously
  and the first effect run opens a serverless WS the backend has already begun
  upgrading into a pty before cleanup can abort it; the second run opens another
  → **two ptys running the same `initialCommand`** (port-binding commands like
  `npm run dev` then fail "address in use"). The 0 ms hop is imperceptible in
  prod.

- **What bounds reconnect is `terminated`, not the attempt count** (~L144). The
  attempt cap (`MAX_RECONNECT_ATTEMPTS`) applies **only** to a *serverless*
  terminal that never attached — there a reconnect can spawn a *fresh* pty, so
  it must stay bounded. A terminal we can re-attach to (has a `serverId`, or
  captured one via an earlier `attached` frame → `attachedOnce`) reconnects to
  its *existing* pty idempotently and so retries **forever** with capped
  backoff, riding out a backend restart/stall without a manual refresh. The real
  stop is `terminated`, set on a clean `exit` / `session_lost` — that is what
  halts the deleted-worktree runaway (else every close → reconnect → another
  doomed pty → close → … spawns thousands). Don't "unify" the two paths into a
  single attempt cap.

- **The narrow deps array + `eslint-disable exhaustive-deps` is deliberate**
  (~L212). The effect depends only on `[cwd, serverId, termRef]`. `onServerId`
  is intentionally excluded and read through a `useSyncedRef` (`onServerIdRef`):
  adding it would re-subscribe — tearing down and rebuilding the WS — every time
  the parent re-renders with a new callback identity. Keep new dependencies out
  of this array unless a change genuinely warrants reconnecting.
