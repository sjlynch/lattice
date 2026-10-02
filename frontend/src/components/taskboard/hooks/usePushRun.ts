import { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkGit,
  fetchPushRunStatus,
  forgetPushRun as apiForgetPushRun,
  mayHaveBeenApplied,
  retryTransient,
  startPushRun,
  type PushRunStatus,
} from '../../../api';
import type { AddTerminal } from '../../../terminal/terminalTypes';
import { useGitSetupNonce } from '../../gitSetup/GitSetupProvider';
import {
  pollWithErrorSentinel,
  useVisibilityPolling,
} from './useVisibilityPolling';

type CloseTerminal = (id: string) => void;

// Poll cadence for the active push run, waiting on its Stop hook to flip it to `done`.
const PUSH_RUN_POLL_INTERVAL_MS = 2000;

// The resolved value of one status poll: a real status object, `null` for a
// genuine 404 (the run is truly gone), or `'error'` when the fetch itself threw
// (network blip, a 5xx, or the `tsc -w` backend restart that happens mid-run) —
// the caller's `.catch` maps a thrown error to this sentinel.
export type PushPollResult = { status: PushRunStatus } | 'error' | null;

type PushPollActions = {
  closeTerminal: () => void;
  forgetRun: () => void;
  clearActive: () => void;
};

// Act on one resolved status poll. A push is torn down — close the local
// terminal, DELETE the run on the backend, clear local tracking — ONLY when it
// is genuinely finished: a real 404 (`null`, already forgotten server-side) or
// status === 'done'. A *transient* fetch failure resolves to `'error'` and is
// ignored here, so the poller simply retries on the next tick.
//
// Collapsing a transient failure into "run gone" (the pre-fix bug, which let a
// thrown fetch become `null` and fall through to teardown) would force-close
// the push pty mid `git commit`/`git push` AND issue a DELETE that forgets a
// still-live run on the backend — so its later Stop-hook `/done` would find
// nothing and emit no 'done' event. Mirrors the hardened useQaRuns poller.
export function applyPushPoll(
  result: PushPollResult,
  { closeTerminal, forgetRun, clearActive }: PushPollActions,
): void {
  if (result === 'error') return;
  if (!result || result.status === 'done') {
    closeTerminal();
    forgetRun();
    clearActive();
  }
}

// Owns the QA-lane Push button: probes for `.git`, kicks off a push run,
// polls its status, and tears down the local terminal once the backend's
// Stop hook flips the run to `done`.
export function usePushRun(
  activeFolder: string,
  addTerminal: AddTerminal,
  closeTerminal: CloseTerminal,
  showError: (msg: string) => void,
) {
  // Active push run, if any. Tracking both ids lets us close the terminal
  // (local) and forget the run on the backend (server) when the Stop hook
  // marks it done. Null when no push is in flight; the QA-lane button is
  // rendered only when activeFolder has a `.git` and disabled while non-null.
  const [activePush, setActivePush] = useState<
    { runId: string; terminalId: string } | null
  >(null);
  const [hasGit, setHasGit] = useState(false);

  // Drop the old project's push tracking when the active folder changes. The
  // poll effect's deps ([activePush, closeTerminal]) don't change on a folder
  // switch, so without this its 2 s interval would keep polling project A's
  // runId and — because the Push button is disabled and `startPush`
  // early-returns while `activePush` is non-null — leave project B unable to
  // push for the entire duration of A's run. The old terminal is project-
  // scoped, so no extra cleanup is needed. Mirrors useQaRuns / useMergeRunSync /
  // usePostMergeHook.
  // `activePush` stays null for the whole POST round-trip, and the button is
  // disabled only off `activePush` — so a double-click used to start TWO push
  // sessions racing `git commit`/`git push` in one repo (the backend does not
  // dedupe). `startingRef` is the in-flight guard. `folderRef` lets a start
  // that resolves after a project switch skip tracking itself as the NEW
  // project's push (which would disable project B's Push button for A's whole
  // run — the exact thing this reset prevents).
  const startingRef = useRef(false);
  const folderRef = useRef(activeFolder);
  useEffect(() => {
    folderRef.current = activeFolder;
    setActivePush(null);
  }, [activeFolder]);

  // Probe for `.git` so the QA-lane Push button is hidden in non-git
  // projects (where the action is meaningless). Re-runs on folder switch and
  // after Git Setup initializes a repo (the nonce bumps), so the button
  // appears without a project switch.
  const gitSetupNonce = useGitSetupNonce();
  useEffect(() => {
    if (!activeFolder) {
      setHasGit(false);
      return;
    }
    let cancelled = false;
    checkGit(activeFolder)
      .then((r) => { if (!cancelled) setHasGit(r.hasGit); })
      .catch(() => { if (!cancelled) setHasGit(false); });
    return () => { cancelled = true; };
  }, [activeFolder, gitSetupNonce]);

  // Poll the active push run; when the backend's Stop hook flips it to
  // `done`, close the local terminal and forget the run. 2 s feels live
  // without hammering the backend (the Claude session is busy doing git
  // operations, not running an inner loop). The visibility-aware interval
  // lifecycle is shared with QA polling; push-specific completion semantics
  // stay here via applyPushPoll.
  const pollActivePush = useCallback(
    async (isCancelled: () => boolean) => {
      if (!activePush) return;
      // A thrown fetch (network blip / 5xx / mid-run backend restart) resolves
      // to the `'error'` sentinel; only a real 404 returns `null`. applyPushPoll
      // ignores the former (retry next tick) and tears down only on a genuine
      // 404 or status === 'done'. See its comment for why conflating the two
      // strands a live push.
      const result = await pollWithErrorSentinel(() =>
        fetchPushRunStatus(activePush.runId),
      );
      if (isCancelled()) return;
      applyPushPoll(result, {
        closeTerminal: () => closeTerminal(activePush.terminalId),
        forgetRun: () => { apiForgetPushRun(activePush.runId).catch(() => {}); },
        clearActive: () => setActivePush(null),
      });
    },
    [activePush, closeTerminal],
  );

  useVisibilityPolling({
    enabled: !!activePush,
    intervalMs: PUSH_RUN_POLL_INTERVAL_MS,
    poll: pollActivePush,
  });

  const startPush = useCallback(async () => {
    if (!activeFolder || activePush || startingRef.current) return;
    startingRef.current = true;
    try {
      // Waits out a backend restart, retrying only failures the backend never
      // acted on — a second start would spawn a second push session.
      const res = await retryTransient(() => startPushRun(activeFolder), {
        retryIf: (err) => !mayHaveBeenApplied(err),
      });
      const terminalId = addTerminal({
        id: res.terminalId,
        label: 'push',
        cwd: res.cwd,
        initialCommand: res.command,
        projectPath: activeFolder,
        serverId: res.serverId,
      });
      if (folderRef.current === activeFolder) {
        setActivePush({ runId: res.id, terminalId });
      }
    } catch (err) {
      showError(`Push failed to start: ${(err as Error).message}`);
    } finally {
      startingRef.current = false;
    }
  }, [activeFolder, activePush, addTerminal, showError]);

  return { activePush, startPush, hasGit };
}
