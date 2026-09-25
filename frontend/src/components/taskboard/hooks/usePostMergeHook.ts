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
  const [saving, setSaving] = useState(false);
  // The folder whose saved form `form` holds, or null while loading. The row
  // disables its controls until then, and the save callbacks check the ref
  // (not a render closure) so none can write over a form we haven't read.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const loadedForRef = useRef<string | null>(null);
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
    setLoadedFor(null);
    if (!activeFolder) return;
    // Strict + retried: the lenient GET mapped a failure (a 502 mid backend
    // restart) to `{}`, so the row read "Off" with an empty prompt while the
    // backend still fired the saved hook after every merge.
    return loadUserSettingsWithRetry(
      activeFolder,
      (s) => {
        setForm({
          prompt: typeof s.postMergeHookPrompt === 'string' ? s.postMergeHookPrompt : '',
          // Absent counts as enabled — mirrors the backend default.
          enabled: s.postMergeHookEnabled !== false,
          harness: normalizeAgentHarness(s.postMergeHookHarness),
          piModel: s.postMergeHookPiModel || undefined,
        });
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

  const savePrompt = useCallback(
    (next: string) => {
      if (!activeFolder || loadedForRef.current !== activeFolder) return;
      setForm((prev) => ({ ...prev, prompt: next }));
      setSaving(true);
      patchUserSettings(activeFolder, { postMergeHookPrompt: next })
        .catch((err) => showError(`Saving hook prompt failed: ${(err as Error).message}`))
        .finally(() => setSaving(false));
    },
    [activeFolder, showError],
  );

  const saveEnabled = useCallback(
    (next: boolean) => {
      if (!activeFolder || loadedForRef.current !== activeFolder) return;
      setForm((prev) => ({ ...prev, enabled: next }));
      setSaving(true);
      patchUserSettings(activeFolder, { postMergeHookEnabled: next })
        .catch((err) => showError(`Saving hook toggle failed: ${(err as Error).message}`))
        .finally(() => setSaving(false));
    },
    [activeFolder, showError],
  );

  const saveHarness = useCallback(
    (next: AgentHarness, piModel?: string) => {
      if (!activeFolder || loadedForRef.current !== activeFolder) return;
      setForm((prev) => ({ ...prev, harness: next, piModel }));
      setSaving(true);
      patchUserSettings(activeFolder, {
        postMergeHookHarness: next,
        // '' clears the stored model (→ Pi default) for bare Pi / non-Pi.
        postMergeHookPiModel: next === 'pi' ? piModel ?? '' : '',
      })
        .catch((err) => showError(`Saving hook harness failed: ${(err as Error).message}`))
        .finally(() => setSaving(false));
    },
    [activeFolder, showError],
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
    saving,
    savePrompt,
    saveEnabled,
    saveHarness,
    abort,
  };
}
