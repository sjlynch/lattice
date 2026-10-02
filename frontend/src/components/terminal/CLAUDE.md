# frontend/src/components/terminal

The xterm UI + WS-connection hooks behind `../TerminalPane.tsx` (which is just
`useRef`s wired into these three hooks). This is the *view/connection* layer;
the tab-list state/storage/pty-DELETE logic lives in `../../terminal/` (its own
CLAUDE.md) — different directory, don't conflate.

- `useTerminalLifecycle.ts` — creates/disposes the `Terminal` + `FitAddon` and
  a `ResizeObserver`. Does **not** attach the WebglAddon. **`serverId` is not a
  dependency** — capturing a backend session id is an attach detail and must not
  dispose+recreate the Terminal. A pane keeps its single Terminal/FitAddon for
  its whole life. **The observer refits only the active pane** (`activeRef`):
  inactive panes are `visibility: hidden`, so they keep a layout size and a
  sidebar drag fired a fit + pty resize on every mounted pane per pointer move.
  An inactive pane refits once when it becomes active (`useActiveTerminalWebgl`).
- `useActiveTerminalWebgl.ts` — attaches a `WebglAddon` only while this pane is
  `active`, disposes it on deactivate. Each WebGL context counts toward Chrome's
  ~16-per-page cap; holding one per terminal made "Run All" blow past it.
  **`serverId` is likewise not a dependency** — only `active` gates the context;
  capturing an id must not churn the GL context.
- `terminalWebgl.ts` — add-on ownership helpers used by the active-WebGL hook.
  Publish the ref only after successful activation, and best-effort dispose
  failed attempts: xterm registers an add-on before `activate` can throw.
  The injected factory allows lifecycle regression tests without a GPU.
- `useTerminalConnection.ts` — the `/ws/terminal` WebSocket wiring: React refs,
  effect lifecycle, WebSocket construction, xterm input/resize forwarding, and
  message dispatch. The reconnect state machine is delegated to
  `terminalReconnectController.ts`; keep the narrow effect deps invariant below.
- `terminalReconnectController.ts` — React/xterm/WebSocket-free reconnect
  lifecycle controller. Owns `terminated` / `attachedOnce` / `attempt`, the
  stability and retry timers, reconnect/give-up transitions, and status/notice
  callbacks injected by the hook.
- `terminalOutput.ts` — queues writes through xterm's asynchronous parse callback.
  Consumes DA, color, cursor/status and other query controls only while parsing
  historical replay, so they cannot generate late `onData` replies in a running
  Codex prompt. Text, styling, terminal modes, live queries and user input remain
  functional. Reads `data.replayed`; retained older executors use the first data
  frame after `attached` as history. Disposal removes parser handlers and drops
  queued writes. Regression: `__tests__/terminalReplayQueries.test.ts`.
- `terminalSocket.ts` — React-free helpers for the connection: `buildTerminalWsUrl`
  (URL building), `handleTerminalMessage` (decode + dispatch), `reconnectDelay` /
  `canReattachTerminal` / `shouldGiveUpReconnect` (backoff/give-up decisions),
  `terminalNotices` (all user-visible terminal-body status lines, in one place),
  and `MAX_RECONNECT_ATTEMPTS`.
  Re-exports `forwardTerminalInput` and `RESIZE_DEBOUNCE_MS` from `terminalInput.ts`
  for existing consumers. **An `attached` frame clears the xterm buffer** before
  the scrollback replay that follows it — a reconnect used to append the ~2 MB
  replay under the content the pane already showed. It is `term.clear()`, never
  `term.reset()`: a full RIS
  also drops the DEC private modes the running TUI switched on at startup
  (bracketed paste, mouse tracking, alternate screen), and those sequences sit
  far outside a long session's replay window, so nothing would restore them.
  Pinned by `__tests__/terminalSocketResize.test.ts`.
- `terminalInput.ts` — `forwardTerminalInput` owns xterm onData/onResize listeners,
  the pending size and the 150 ms trailing resize timer (`RESIZE_DEBOUNCE_MS`).
  Input sends immediately; every send looks up the current OPEN socket. Disposal
  removes both listeners and cancels/drops the pending resize without sending it.
  Debouncing sends only a drag's settled size: every pty resize is a SIGWINCH,
  and Codex's resize reflow can re-emit thousands of transcript rows per change.
  Pinned by `__tests__/terminalSocketResize.test.ts` via the old import path.
- `terminalConfig.ts` — `Terminal` options + theme. `clipboardPaste.ts` — Ctrl+V
  → `term.paste()` (xterm would otherwise forward ^V as a raw byte).

## Load-bearing invariants in the terminal connection lifecycle

These look like accidents and are not — each fixes a specific past incident.
Don't "clean them up" without resurrecting the bug.

- **`setTimeout(connect, 0)` is required, not a smell**. It defers the
  WS open by one task tick so React StrictMode's synchronous cleanup (which calls
  `controller.cancel()`) runs *before* the handshake starts. Connect synchronously
  and the first effect run opens a serverless WS the backend has already begun
  upgrading into a pty before cleanup can abort it; the second run opens another
  → **two ptys running the same `initialCommand`** (port-binding commands like
  `npm run dev` then fail "address in use"). The 0 ms hop is imperceptible in
  prod.

- **What bounds reconnect is `terminated`, not the attempt count**. The
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

- **The backoff resets on a STABILITY timer, not in `onopen`**. `attempt` is
  zeroed only after a connection survives `RECONNECT_STABLE_MS` (~3s) — a timer
  armed in `onopen` and *cleared in `onclose`* — never the instant the socket
  opens. Resetting in `onopen` looks equivalent and is the bug: a backend that
  completes the WS upgrade (101 → `onopen`) then immediately closes (half-booted
  behind a proxy) would zero the counter every open, so `reconnectDelay(0)` pins
  the loop at the 250ms floor, `shouldGiveUpReconnect` is never reached, and a
  *serverless* terminal re-runs its `initialCommand` — spawning a fresh pty —
  every ~250ms forever. Mirrors `api/ws.ts`'s `subscribeWs` `WS_STABLE_MS`.
  Regression: `__tests__/terminalReconnectStability.test.ts`.

- **The narrow deps array + `eslint-disable exhaustive-deps` is deliberate**.
  The effect depends only on `[cwd, termRef]`. Both `onServerId` **and**
  `serverId` are intentionally excluded and read through `useSyncedRef`s
  (`onServerIdRef` / `serverIdRef`). For `onServerId`: a new callback identity
  each parent render would otherwise re-subscribe (tear down + rebuild the WS).
  For `serverId`: a serverless terminal *captures* its id from the first
  `attached` frame (`onServerId` → parent state → new `serverId` prop); if it
  were a dep, that capture would tear down the live WS and reopen a second one —
  and, because the same capture used to recreate the Terminal, flash/clear the
  pane and drop the first keystroke. Reading it via a ref keeps the single WS
  (and Terminal) intact on capture, while still feeding the latest id into a
  later reconnect so it re-attaches to the existing pty by id (not a fresh
  spawn). The connect URL is built by `terminalSocket.buildTerminalWsUrl`, whose
  pure, window-free core `buildTerminalWsQuery` (in `connectionParams.ts`) is
  unit-tested. Keep new dependencies out of this array unless a change genuinely
  warrants reconnecting.
