# backend/src/fleet

Fleet: one view of, and one set of controls over, every project on this
machine. Facade: `../fleet.ts`. Routes: `../routes/fleet.ts`. UI:
`frontend/src/components/fleet/`. MCP: `../latticeMcp/tools/fleetTools.ts`.

## Map

- `types.ts` — node-free wire types (`FleetSnapshot`, `FleetProject`,
  `FleetTerminal`, `FleetEvent`, `TerminalScreen`, `FleetLaunchResult`).
- `events.ts` — the machine-wide activity feed: a bounded (500) in-memory
  log fed by the per-project emitters that already exist (tasks, task spawns,
  workflow / merge runs, agent sessions, terminal registry). Task boards are
  diffed against the last status seen per task; a board's first snapshot only
  seeds. Emits nothing itself.
- `snapshot.ts` — `buildFleetProjects` over injected readers: projects with
  live terminals, agents, runs or in-flight tasks, plus any touched in the
  last 7 days (≤ 40, live ones first).
- `terminal.ts` — screen / input / wait for any pty, each call one
  short-lived client of the executor's `/ws/terminal?id=` attach socket.
- `launch.ts` — "prompt a project": the prompt goes to
  `<project>/.lattice/fleet-prompts/<id>.md` and the agent launches with a
  short pointer to it through the normal spawn chokepoint.

## Invariants

- **Never touch the executor.** Terminal control is a plain attach client:
  it never resizes (a resize would reflow the user's pane), never kills, and
  adds no executor route (its fingerprint would mark it stale until every
  pty closes). Input is stamped like browser input (`noteTerminalClientInput`,
  `noteTerminalPromptSubmit`) so the activity and replay-guard signals hold.
- **Prompt text never rides a command line.** It goes to a file under the
  project's gitignored `.lattice/`; the command carries only a fixed pointer.
- **No recursive escalation.** A terminal an AGENT launches carries
  `mcpScope: 'fleet-agent'`, so it is never user-launched: no
  `lattice-control`, no fleet tools. A human launching from the Fleet view
  gets a plain user tab.
- **Agent gate.** Non-browser callers (no `Origin` / `Sec-Fetch-Site`) may
  read `/api/fleet` but need the `fleetAgentControl` global setting (default
  off) to launch, read a screen, type or wait. A guardrail for well-behaved
  agents, not authentication: the local API has none.
- What an agent reads from another terminal is untrusted data; the MCP tool
  descriptions say so.
- In-memory only (feed, busy set); a restart starts a fresh feed.
- Paired PCs (`../peers/`): `/api/fleet` adds `machines` (each PC's own
  snapshot through its gateway) unless the request itself came from a peer;
  every fleet call takes a `machine` (FE `onMachine`, MCP `machine`) routed
  through `/api/peer/:name/*`.

## Tests

`fleet.snapshot.test.ts` (snapshot + event log), `fleet.terminal.test.ts`
(a fake executor speaking the attach protocol), `fleet.launch.test.ts`,
`fleet.routes.test.ts` (the agent gate) in `../__tests__/`.
