import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
} from 'react';
import {
  fetchHarnessSystemPrompts,
  fetchUserSettings,
  type HarnessSystemPromptEntry,
  type UserSettings,
} from '../../api';
import { HarnessSystemPromptCard } from './HarnessSystemPromptCard';

type Props = {
  active: boolean;
  open: boolean;
  activeFolder: string;
};

// The persisted shape: per-harness { append?, replace? }, blank sides dropped.
type HarnessSystemPromptsMap = NonNullable<UserSettings['harnessSystemPrompts']>;

export type HarnessSystemPromptsTabHandle = {
  // The full desired `harnessSystemPrompts` map (replaces the saved one), or
  // undefined until the seeding fetch completes / the user edits nothing — the
  // clobber-guard, matching the other override-merge tabs.
  getHarnessSystemPromptsPatch: () => HarnessSystemPromptsMap | undefined;
};

// Bespoke draft engine — the saved shape is nested ({harness: {append, replace}})
// rather than the flat Record<string,string> the shared useOverrideDraft handles,
// so this keeps two per-harness draft maps and merges them on save with the same
// undefined-until-loaded clobber-guard.
function useHarnessSystemPromptsDraft(
  open: boolean,
  active: boolean,
  activeFolder: string,
) {
  const [entries, setEntries] = useState<HarnessSystemPromptEntry[]>([]);
  const [appendDraft, setAppendDraft] = useState<Record<string, string>>({});
  const [replaceDraft, setReplaceDraft] = useState<Record<string, string>>({});
  const [existing, setExisting] = useState<HarnessSystemPromptsMap>({});
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !active || !activeFolder) return;
    let cancelled = false;
    setLoading(true);
    setLoaded(false);
    setError(null);
    Promise.all([
      fetchHarnessSystemPrompts(activeFolder),
      fetchUserSettings(activeFolder),
    ])
      .then(([list, settings]) => {
        if (cancelled) return;
        setEntries(list);
        setAppendDraft(
          Object.fromEntries(list.map((e) => [e.harness, e.currentAppend])),
        );
        setReplaceDraft(
          Object.fromEntries(list.map((e) => [e.harness, e.currentReplace])),
        );
        setExisting(settings.harnessSystemPrompts ?? {});
        setTouched(false);
        setLoaded(true);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message || 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, active, activeFolder]);

  const setAppend = useCallback((harness: string, text: string) => {
    setAppendDraft((d) => ({ ...d, [harness]: text }));
    setTouched(true);
  }, []);
  const setReplace = useCallback((harness: string, text: string) => {
    setReplaceDraft((d) => ({ ...d, [harness]: text }));
    setTouched(true);
  }, []);

  const getPatch = useCallback((): HarnessSystemPromptsMap | undefined => {
    if (!loaded || !touched) return undefined;
    const next: HarnessSystemPromptsMap = { ...existing };
    for (const e of entries) {
      const append = appendDraft[e.harness] ?? e.currentAppend;
      const replace = replaceDraft[e.harness] ?? e.currentReplace;
      const sides: { append?: string; replace?: string } = {};
      if (append.trim().length > 0) sides.append = append;
      if (replace.trim().length > 0) sides.replace = replace;
      if (Object.keys(sides).length > 0) next[e.harness] = sides;
      else delete next[e.harness];
    }
    return next;
  }, [loaded, touched, existing, entries, appendDraft, replaceDraft]);

  return {
    entries,
    appendDraft,
    replaceDraft,
    loading,
    error,
    setAppend,
    setReplace,
    getPatch,
  };
}

export const HarnessSystemPromptsTab = forwardRef<
  HarnessSystemPromptsTabHandle,
  Props
>(function HarnessSystemPromptsTab({ active, open, activeFolder }, ref) {
  const {
    entries,
    appendDraft,
    replaceDraft,
    loading,
    error,
    setAppend,
    setReplace,
    getPatch,
  } = useHarnessSystemPromptsDraft(open, active, activeFolder);

  useImperativeHandle(
    ref,
    () => ({ getHarnessSystemPromptsPatch: getPatch }),
    [getPatch],
  );

  if (!active) return null;

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <div>
          <div className="settings-section-title">Harness system prompts</div>
          <div className="settings-section-sub">
            Customize the agent's own built-in system prompt per harness, for
            every Claude / Codex / Pi session Lattice spawns in this project. Use{' '}
            <strong>Append</strong> to add rules on top of the default (safe), or{' '}
            <strong>Replace</strong> to swap it entirely (advanced). Leave a box
            blank to keep the built-in default. Expand a harness to view its
            default and edit.
          </div>
        </div>
      </div>
      {loading ? (
        <div className="settings-empty">Loading…</div>
      ) : error ? (
        <div className="error-msg">{error}</div>
      ) : entries.length === 0 ? (
        <div className="settings-empty">No harnesses.</div>
      ) : (
        <div className="prompt-tpl-list">
          {entries.map((entry) => (
            <HarnessSystemPromptCard
              key={entry.harness}
              entry={entry}
              append={appendDraft[entry.harness] ?? entry.currentAppend}
              replace={replaceDraft[entry.harness] ?? entry.currentReplace}
              onChangeAppend={(text) => setAppend(entry.harness, text)}
              onChangeReplace={(text) => setReplace(entry.harness, text)}
            />
          ))}
        </div>
      )}
    </div>
  );
});
