import { useCallback, useEffect, useRef, useState } from 'react';
import {
  abortPostMergeHook,
  fetchUserSettings,
  getActivePostMergeHook,
  patchUserSettings,
  subscribePostMergeHooks,
  type PostMergeHookRun,
} from '../../../api';
import { normalizeAgentHarness, type AgentHarness } from '../../../harnesses';
import type { TerminalSpec } from '../../../TerminalsContext';

type AddTerminal = (spec: Omit<TerminalSpec, 'id'>, focus?: boolean) => string;

export type PostMergeHookFormState = {
  prompt: string;
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
    harness: 'claude',
  });
  const [active, setActive] = useState<PostMergeHookRun | null>(null);
  const [recent, setRecent] = useState<PostMergeHookRun | null>(null);
  const [saving, setSaving] = useState(false);
  // Track which hook ids we've already spawned a terminal tab for, so the
  // WS firing multiple progress events (or a reconnect re-sending 'started')
  // doesn't open a new terminal each time. A ref instead of state because the
  // set is consulted inside the WS callback (we don't render off it) — keeping
  // it out of the render cycle avoids a stale-closure footgun.
  const spawnedTerminalsRef = useRef<Set<string>>(new Set());

  // Load saved prompt + harness on folder change.
  useEffect(() => {
    let cancelled = false;
    // Reset to defaults synchronously BEFORE the fetch resolves — mirrors the
    // sibling hydrate effect's active/recent reset. Without this, a project
    // switch leaves the PREVIOUS project's prompt in the form until the new
    // fetch lands (a transient flash), and if that fetch rejects the catch
    // below "keeps defaults" that are actually the old project's — so a later
    // savePrompt/saveHarness would patch project A's prompt onto project B.
    setForm({ prompt: '', harness: 'claude' });
    if (!activeFolder) return;
    fetchUserSettings(activeFolder)
      .then((s) => {
        if (cancelled) return;
        setForm({
          prompt: typeof s.postMergeHookPrompt === 'string' ? s.postMergeHookPrompt : '',
          harness: normalizeAgentHarness(s.postMergeHookHarness),
          piModel: s.postMergeHookPiModel || undefined,
        });
      })
      .catch(() => {
        /* keep the defaults reset above — never retain the prior project's form */
      });
    return () => {
      cancelled = true;
    };
  }, [activeFolder]);

  // Hydrate + subscribe to live updates.
  useEffect(() => {
    setActive(null);
    setRecent(null);
    spawnedTerminalsRef.current = new Set();
    if (!activeFolder) return;
    let cancelled = false;

    getActivePostMergeHook(activeFolder)
      .then((snap) => {
        if (cancelled) return;
        setActive(snap.active);
        setRecent(snap.recent);
      })
      .catch(() => {
        /* ignore — WS will populate */
      });

    const unsub = subscribePostMergeHooks(activeFolder, (ev) => {
      if (cancelled) return;
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
      setForm((prev) => ({ ...prev, prompt: next }));
      if (!activeFolder) return;
      setSaving(true);
      patchUserSettings(activeFolder, { postMergeHookPrompt: next })
        .catch((err) => showError(`Saving hook prompt failed: ${(err as Error).message}`))
        .finally(() => setSaving(false));
    },
    [activeFolder, showError],
  );

  const saveHarness = useCallback(
    (next: AgentHarness, piModel?: string) => {
      setForm((prev) => ({ ...prev, harness: next, piModel }));
      if (!activeFolder) return;
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
    active,
    recent,
    saving,
    savePrompt,
    saveHarness,
    abort,
  };
}
