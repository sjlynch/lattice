import { useCallback, useEffect, useRef, useState } from 'react';
import {
  abortPostMergeHook,
  getActivePostMergeHook,
  patchUserSettings,
  subscribePostMergeHooks,
  type PostMergeHookRun,
} from '../../../api';
import { normalizeAgentHarness, type AgentHarness } from '../../../harnesses';
import type { AddTerminalSpec } from '../../../terminal/terminalTypes';
import { saveOptimistic } from './optimisticSave';
import { loadUserSettingsWithRetry } from './strictSettingsLoad';

type AddTerminal = (spec: AddTerminalSpec, focus?: boolean) => string;

export type PostMergeHookFormState = {
  prompt: string;
  // Master on/off switch. The hook fires only when enabled AND prompt is
  // non-empty. Default ON (absent persisted value counts as enabled).
  enabled: boolean;
  harness: AgentHarness;
  // Pi model for the hook; used only when harness is `pi`.
  piModel?: string;
};

// Per-project state for the PostMergeHookRow: the persisted prompt/harness
// form values plus the live active/recent hook run. The component owns
// presentation; this hook owns I/O.
export function usePostMergeHook(
  activeFolder: string,
  addTerminal: AddTerminal,
  showError: (msg: string) => void,
) {
  const [form, setForm] = useState<PostMergeHookFormState>({
    prompt: '',
    enabled: true,
    harness: 'claude',
  });
  const [active, setActive] = useState<PostMergeHookRun | null>(null);
  const [recent, setRecent] = useState<PostMergeHookRun | null>(null);
  // In-flight save count, not a boolean: with one shared flag the first PATCH
  // to settle cleared it while another was still in flight.
  const [pendingSaves, setPendingSaves] = useState(0);
  // The folder whose saved form `form` holds, or null while loading. The row
  // disables its controls until then, and the save callbacks check the ref
  // (not a render closure) so none can write over a form we haven't read.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const loadedForRef = useRef<string | null>(null);
  // The form the backend last loaded or acknowledged — what a failed toggle /
  // harness save reverts to. A fresh object per load, so a save settling after
  // a project switch (even back to the same project) can't revert the new form.
  const confirmedRef = useRef<PostMergeHookFormState | null>(null);
  // Latest save per field: an earlier save that fails after a later one was
  // issued leaves the UI to the later save's outcome.
  const saveSeqRef = useRef({ enabled: 0, harness: 0 });
  // Track which hook ids we've already spawned a terminal tab for, so the
  // WS firing multiple progress events (or a reconnect re-sending 'started')
  // doesn't open a new terminal each time. A ref instead of state because the
  // set is consulted inside the WS callback (we don't render off it) — keeping
  // it out of the render cycle avoids a stale-closure footgun.
  const spawnedTerminalsRef = useRef<Set<string>>(new Set());

  // Load saved prompt + harness on folder change.
  useEffect(() => {
    // Reset to defaults synchronously BEFORE the fetch resolves — mirrors the
    // sibling hydrate effect's active/recent reset. Without this, a project
    // switch leaves the PREVIOUS project's prompt in the form until the new
    // fetch lands (a transient flash). The loaded gate is dropped with it, so
    // no save can patch project A's form onto project B meanwhile.
    setForm({ prompt: '', enabled: true, harness: 'claude' });
    loadedForRef.current = null;
    confirmedRef.current = null;
    setLoadedFor(null);
    if (!activeFolder) return;
    // Strict + retried: the lenient GET mapped a failure (a 502 mid backend
    // restart) to `{}`, so the row read "Off" with an empty prompt while the
    // backend still fired the saved hook after every merge.
    return loadUserSettingsWithRetry(
      activeFolder,
      (s) => {
        const loaded: PostMergeHookFormState = {
          prompt: typeof s.postMergeHookPrompt === 'string' ? s.postMergeHookPrompt : '',
          // Absent counts as enabled — mirrors the backend default.
          enabled: s.postMergeHookEnabled !== false,
          harness: normalizeAgentHarness(s.postMergeHookHarness),
          piModel: s.postMergeHookPiModel || undefined,
        };
        setForm(loaded);
        confirmedRef.current = { ...loaded };
        loadedForRef.current = activeFolder;
        setLoadedFor(activeFolder);
      },
      'post-merge hook',
    );
  }, [activeFolder]);

  // Hydrate + subscribe to live updates.
  useEffect(() => {
    setActive(null);
    setRecent(null);
    spawnedTerminalsRef.current = new Set();
    if (!activeFolder) return;
    let cancelled = false;
    let receivedLiveState = false;

    getActivePostMergeHook(activeFolder)
      .then((snap) => {
        if (cancelled || receivedLiveState) return;
        setActive(snap.active);
        setRecent(snap.recent);
      })
      .catch(() => {
        /* ignore — WS will populate */
      });

    const unsub = subscribePostMergeHooks(activeFolder, (ev) => {
      if (cancelled) return;
      receivedLiveState = true;
      if (ev.type === 'idle') {
        setActive(null);
        return;
      }
      if (ev.type === 'started' || ev.type === 'progress') {
        if (ev.run.status === 'running') {
          setActive(ev.run);
          // Spawn a terminal tab the first time we see this run with a
          // serverId. The backend pre-creates the pty so the WS pane just
          // attaches to it; only one tab per hook even if WS reconnects
          // resend the 'started' event.
          if (ev.run.serverId && !spawnedTerminalsRef.current.has(ev.run.id)) {
            spawnedTerminalsRef.current.add(ev.run.id);
            // focus=true so the terminal tab actually pops into view — the
            // hook is blocking the merge step, so the user should see what's
            // happening immediately rather than have to hunt for the tab
            // (the first cut shipped focus=false and left users wondering
            // whether the hook had even started).
            addTerminal(
              {
                id: ev.run.terminalId,
                label: `post-merge:${ev.run.id.slice(-6)}`,
                cwd: ev.run.cwd,
                projectPath: ev.run.projectPath,
                serverId: ev.run.serverId,
              },
              true,
            );
          }
        } else {
          setActive(null);
          setRecent(ev.run);
        }
      } else if (ev.type === 'finished') {
        setActive(null);
        setRecent(ev.run);
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [activeFolder, addTerminal]);

  const beginSave = useCallback(() => setPendingSaves((n) => n + 1), []);
  const endSave = useCallback(() => setPendingSaves((n) => n - 1), []);

  // The prompt is saved but never reverted on failure: that would throw away
  // what the user typed. The error toast says it didn't land.
  const savePrompt = useCallback(
    (next: string) => {
      if (!activeFolder || loadedForRef.current !== activeFolder) return;
      const confirmed = confirmedRef.current;
      setForm((prev) => ({ ...prev, prompt: next }));
      beginSave();
      patchUserSettings(activeFolder, { postMergeHookPrompt: next })
        .then(() => {
          if (confirmed) confirmed.prompt = next;
        })
        .catch((err) => showError(`Saving hook prompt failed: ${(err as Error).message}`))
        .finally(endSave);
    },
    [activeFolder, showError, beginSave, endSave],
  );

  const saveEnabled = useCallback(
    (next: boolean) => {
      const confirmed = confirmedRef.current;
      if (!activeFolder || loadedForRef.current !== activeFolder || !confirmed) return;
      const folder = activeFolder;
      const seq = ++saveSeqRef.current.enabled;
      beginSave();
      void saveOptimistic(next, {
        persist: (value) => patchUserSettings(folder, { postMergeHookEnabled: value }),
        apply: (value) => setForm((prev) => ({ ...prev, enabled: value })),
        isCurrent: () =>
          confirmedRef.current === confirmed && saveSeqRef.current.enabled === seq,
        previous: () => confirmed.enabled,
        onSaved: (value) => {
          confirmed.enabled = value;
        },
        onError: (err) => showError(`Saving hook toggle failed: ${(err as Error).message}`),
        onSettled: endSave,
      });
    },
    [activeFolder, showError, beginSave, endSave],
  );

  const saveHarness = useCallback(
    (next: AgentHarness, piModel?: string) => {
      const confirmed = confirmedRef.current;
      if (!activeFolder || loadedForRef.current !== activeFolder || !confirmed) return;
      const folder = activeFolder;
      const seq = ++saveSeqRef.current.harness;
      beginSave();
      void saveOptimistic(
        { harness: next, piModel },
        {
          persist: (value) =>
            patchUserSettings(folder, {
              postMergeHookHarness: value.harness,
              // '' clears the stored model (→ Pi default) for bare Pi / non-Pi.
              postMergeHookPiModel: value.harness === 'pi' ? value.piModel ?? '' : '',
            }),
          apply: (value) =>
            setForm((prev) => ({ ...prev, harness: value.harness, piModel: value.piModel })),
          isCurrent: () =>
            confirmedRef.current === confirmed && saveSeqRef.current.harness === seq,
          previous: () => ({ harness: confirmed.harness, piModel: confirmed.piModel }),
          onSaved: (value) => {
            confirmed.harness = value.harness;
            confirmed.piModel = value.piModel;
          },
          onError: (err) => showError(`Saving hook harness failed: ${(err as Error).message}`),
          onSettled: endSave,
        },
      );
    },
    [activeFolder, showError, beginSave, endSave],
  );

  const abort = useCallback(async () => {
    if (!active) return;
    try {
      await abortPostMergeHook(active.id);
    } catch (err) {
      showError(`Abort failed: ${(err as Error).message}`);
    }
  }, [active, showError]);

  return {
    form,
    loaded: !!activeFolder && loadedFor === activeFolder,
    active,
    recent,
    saving: pendingSaves > 0,
    savePrompt,
    saveEnabled,
    saveHarness,
    abort,
  };
}
