import { useCallback, useEffect, useRef } from 'react';
import type { StartupTerminal } from '../../../api';
import type { TerminalSpec } from '../../../TerminalsContext';
import type { AddTerminalSpec } from '../../../terminal/terminalTypes';
import { createBackendSession, fetchLiveTerminalIds } from '../../../terminal/terminalApi';
import { fetchTerminalTabs } from '../../../api';
import { planStartupSeeding, startupInFlightKey } from './startupSeedPlan';

// Retry schedule for the seeding pass's two backend reads while the backend
// is still booting. Mirrors REGISTRY_FETCH_ATTEMPTS / REGISTRY_FETCH_RETRY_MS
// in TerminalsContext.tsx (attempt n waits n × 750 ms).
const SEED_FETCH_ATTEMPTS = 4;
const SEED_FETCH_RETRY_MS = 750;

type UseStartupTerminalsArgs = {
  activeFolder: string;
  startupTerminals: StartupTerminal[];
  projectTerminals: TerminalSpec[];
  addTerminal: (spec: AddTerminalSpec, focus?: boolean) => string;
  closeTerminals: (ids: string[]) => void;
};

// Spawn one startup terminal. Pre-created through the backend chokepoint so
// (a) a harness set as a startup command gets its MCP config and (b) the tab
// lands in the durable registry as `owner: startup`. A pre-create failure
// falls back to the serverless connect (the pane's WS attach runs the
// command), exactly the old behaviour.
async function spawnStartup(
  cfg: StartupTerminal,
  activeFolder: string,
  addTerminal: UseStartupTerminalsArgs['addTerminal'],
): Promise<void> {
  const label = cfg.label || 'startup';
  const created = await createBackendSession({
    cwd: activeFolder,
    initialCommand: cfg.command,
    projectPath: activeFolder,
    label,
    owner: 'startup',
    startupId: cfg.id,
  });
  addTerminal(
    {
      id: created?.terminalId,
      label,
      cwd: activeFolder,
      initialCommand: cfg.command,
      projectPath: activeFolder,
      kind: 'startup',
      startupId: cfg.id,
      serverId: created?.serverId,
      registered: !!created?.terminalId,
    },
    false, // don't steal focus
  );
}

export function useStartupTerminals({
  activeFolder,
  startupTerminals,
  projectTerminals,
  addTerminal,
  closeTerminals,
}: UseStartupTerminalsArgs) {
  // Mirror the latest projectTerminals into a ref so the seeding effect
  // can detect already-running startup terminals after a page refresh
  // without re-running every time the terminals list changes.
  const projectTerminalsRef = useRef(projectTerminals);
  useEffect(() => {
    projectTerminalsRef.current = projectTerminals;
  }, [projectTerminals]);

  // Synchronously-updated dedup so React StrictMode's double-fire of the
  // seeding effect can't add the same startup twice. The existing.some()
  // check below reads projectTerminalsRef, which is updated by a separate
  // effect — that effect only fires AFTER a React commit, but StrictMode
  // double-invokes effects synchronously (run → cleanup → run) BEFORE any
  // commit, so both runs see the same stale snapshot. Without this, every
  // configured startup spawns two ptys that race for the same port; with
  // `npm run dev` the second one fails with "address in use" while the
  // first invisibly holds it.
  const inFlightStartupRef = useRef<Set<string>>(new Set());

  // Drop in-flight markers once the corresponding TerminalSpec has actually
  // committed to state. Without this, closing a startup tab and then
  // changing settings would refuse to respawn (the ref still has the key).
  useEffect(() => {
    if (inFlightStartupRef.current.size === 0) return;
    const liveKeys = new Set<string>();
    for (const t of projectTerminals) {
      if (t.kind === 'startup' && t.startupId && t.projectPath) {
        liveKeys.add(`${t.projectPath}::${t.startupId}`);
      }
    }
    for (const key of inFlightStartupRef.current) {
      if (!liveKeys.has(key)) inFlightStartupRef.current.delete(key);
    }
  }, [projectTerminals]);

  // Validate persisted serverIds and auto-spawn startup terminals.
  //
  // Page reloads keep TerminalSpecs (with serverId) in sessionStorage,
  // but the backend pty for those ids may be gone — Lattice's shutdown
  // hook intentionally kills every pty so subsequent dev cycles start
  // clean. Without this check the stale spec would mount, attach, get
  // session_lost, and sit there showing the message until the user
  // closes the tab. We fetch the live session list, drop any spec
  // whose serverId no longer exists, and respawn startup terminals
  // whose backing pty is gone so the user's configured commands are
  // running by the time they look at the sidebar.
  useEffect(() => {
    if (!activeFolder) return;
    let cancelled = false;
    void (async () => {
      // liveIds: null = couldn't validate (backend unreachable / non-OK). In
      // that case the drop-stale step is skipped entirely instead of treating
      // every persisted serverId as dead — a transient failure shouldn't wipe
      // the user's terminals.
      // records: the registry's own view of this project's tabs. The local
      // list can lag it (a fresh browser context has NO local specs until the
      // registry snapshot lands), and a startup whose pty is alive in the
      // registry must not be spawned a second time — see planStartupSeeding.
      //
      // Both reads fail together while the backend is down (a restart under
      // the page). Live ptys SURVIVE a backend restart, so deciding from two
      // nulls on a fresh browser context — no local specs either — would
      // spawn a second `npm run dev` beside the still-alive one once the
      // backend returns. Retry the pair a few times first (mirrors the
      // registry fetch in TerminalsContext); planStartupSeeding spawns
      // nothing if both are still unreadable after that.
      const fetchPair = () =>
        Promise.all([
          fetchLiveTerminalIds(),
          fetchTerminalTabs(activeFolder).catch(() => null),
        ]);
      let [liveIds, records] = await fetchPair();
      for (let n = 1; n < SEED_FETCH_ATTEMPTS && (liveIds === null || records === null); n++) {
        if (cancelled) return;
        await new Promise<void>((res) => setTimeout(res, SEED_FETCH_RETRY_MS * n));
        if (cancelled) return;
        [liveIds, records] = await fetchPair();
      }
      if (cancelled) return;

      const plan = planStartupSeeding({
        activeFolder,
        configs: startupTerminals,
        existing: projectTerminalsRef.current,
        liveIds,
        records,
        inFlight: inFlightStartupRef.current,
      });

      // Drop UNREGISTERED specs whose serverId is gone (legacy sessionStorage
      // tabs from before the registry). closeTerminals tolerates a 404 from
      // the DELETE; the local state is what matters here.
      //
      // A REGISTERED tab is the registry's to reconcile: after a crash or
      // reboot its recorded pty id is dead by definition, and the restore
      // pass is about to relaunch it. Closing it here would DELETE the
      // record and there would be nothing left to restore.
      if (plan.staleIds.length > 0) closeTerminals(plan.staleIds);

      // Spawn each configured startup with no live spec anywhere. When liveIds
      // is null (validation failed) every existing spec counts as live and
      // only truly missing ones spawn — the original seeding behaviour.
      for (const cfg of plan.spawn) {
        inFlightStartupRef.current.add(startupInFlightKey(activeFolder, cfg.id));
        void spawnStartup(cfg, activeFolder, addTerminal);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeFolder, startupTerminals, addTerminal, closeTerminals]);

  // Stop and restart every startup terminal for the active project. We
  // explicitly re-add here rather than waiting for the seeding effect: the
  // effect's deps (activeFolder, startupTerminals) haven't changed, so it
  // wouldn't fire again on its own.
  const restartStartupTerminals = useCallback(() => {
    if (!activeFolder) return;
    const ids = projectTerminalsRef.current
      .filter((t) => t.kind === 'startup' && t.projectPath === activeFolder)
      .map((t) => t.id);
    if (ids.length > 0) closeTerminals(ids);
    for (const cfg of startupTerminals) {
      if (!cfg.command.trim()) continue;
      void spawnStartup(cfg, activeFolder, addTerminal);
    }
  }, [activeFolder, closeTerminals, addTerminal, startupTerminals]);

  return { restartStartupTerminals };
}
