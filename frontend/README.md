# Lattice frontend

The Vite + React + TypeScript UI: a 3D force-directed graph of the project's
source tree, xterm terminals, and the task board.

Runs on `http://localhost:5183` and talks to the backend on `:5184`. Start it
with `npm run dev` from the repo root (runs backend + frontend together).

## Browser memory troubleshooting

For intermittent Chrome "Out of memory" failures, especially when taking a
heap snapshot changes the symptom:

1. **Record the setup.** Include Chrome/OS versions, RAM, GPU/driver, Lattice
   commit, project file/node counts, terminal-tab count and active pane. Note
   graph overlays (H/Z/D/W, Alt labels, Security), pinned states and settings
   such as pixel ratio, batched nodes/links and Show links. Write down the exact
   actions, elapsed time and failure text; compare the same setup on the other PC.
2. **Preserve measurements before collection.** Open Chrome Task Manager
   (`Shift+Esc`, or More tools → Task manager); right-click its header to enable
   JavaScript memory. Record the Lattice renderer tab's Memory footprint (OS
   memory) and JavaScript memory, including the live value in parentheses, plus
   the GPU Process row. Track the backend Node PID/memory separately in the OS
   task manager. Save timestamped readings/screenshots and DevTools Console
   errors before reloading, clicking Collect garbage or taking a snapshot.
   A Performance recording with Memory enabled can preserve the trend; keep
   this first run free of manual GC. See Chrome's
   [memory troubleshooting guide](https://developer.chrome.com/docs/devtools/memory-problems).
3. **Compare repeated actions.** From a recorded baseline, repeat project
   switches A → B → A, overlay on/off cycles, and terminal activation/deactivation
   separately, changing one factor per run. Use the same cycle count and idle
   pause, record which process grows, and check whether usage settles or each
   cycle leaves a higher baseline. Keep a run without snapshots for comparison.
   The [GPU process serves multiple renderer processes](https://www.chromium.org/developers/design-documents/gpu-accelerated-compositing-in-chrome/#command-buffer-multiplexing),
   so its growth alone does not identify this tab as the cause.
4. **Then collect heap evidence.** In DevTools Memory, select the page's VM,
   take a baseline snapshot, repeat the same cycles, then take another snapshot.
   Use Comparison and Retainers to investigate growing object counts, retained
   sizes and detached DOM nodes; save the profiles with the reproduction notes.
   Chrome documents that
   [heap snapshots start with garbage collection](https://developer.chrome.com/docs/devtools/memory-problems/heap-snapshots)
   and show reachable objects. Record the pre/post-collection readings and any
   symptom change: relief proves neither a GC defect nor a particular leak.
   These snapshots do not measure all native/GPU memory or the Node backend.

**Graph recovery:** Lattice's "3D graph unavailable" / "GPU context lost" notice
is a WebGL failure inside the app; Chrome's tab OOM page replaces the app.
Retry ("Rebuild graph" after context loss) remounts the graph coordinator and
its hooks. A restored context clears the notice. xterm attaches WebGL only to
an active pane and disposes it on deactivation, context loss or failed activation,
falling back to its DOM renderer. After saving evidence, retry; if failure
persists, fully quitting/reopening Chrome may help recover GPU resources, but
does not establish the cause or guarantee recovery. Recent cleanup fixes do
not prove the original intermittent OOM is solved.

Ownership: [graph](src/components/forceGraph/CLAUDE.md),
[graph lifecycle hooks](src/components/forceGraph/hooks/CLAUDE.md), and
[terminal rendering](src/components/terminal/CLAUDE.md).
For Node/backend failures, attach relevant `~/.lattice/logs/` evidence described
in [crash logging](../backend/src/crashLog/CLAUDE.md); missing `report.*.json`
does not rule out a backend crash.

## Docs

- [src/CLAUDE.md](src/CLAUDE.md) — authoritative navigation doc for the UI code
  (feature subdirectories carry their own `CLAUDE.md` with local conventions).
- Root [README.md](../README.md) / [CLAUDE.md](../CLAUDE.md) — project overview
  and architecture.
