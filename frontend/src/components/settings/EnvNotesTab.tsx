import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  fetchProjectEnv,
  fetchUserSettings,
  type ProjectEnvInfo,
} from '../../api';

type Props = {
  active: boolean;
  open: boolean;
  activeFolder: string;
};

export type EnvNotesTabHandle = {
  getWorktreeEnvNotesPatch: () => Record<string, string> | undefined;
};

export const EnvNotesTab = forwardRef<EnvNotesTabHandle, Props>(
  function EnvNotesTab({ active, open, activeFolder }, ref) {
    // `envs` is what the backend detected (+ default and effective notes);
    // `envDraft` is the editable text keyed by env id; `existingOverrides` is
    // the raw saved map so we don't clobber overrides for envs that aren't
    // currently detected.
    const [envs, setEnvs] = useState<ProjectEnvInfo[]>([]);
    const [envDraft, setEnvDraft] = useState<Record<string, string>>({});
    const [existingOverrides, setExistingOverrides] = useState<Record<string, string>>({});
    const [envLoading, setEnvLoading] = useState(false);
    // Guards against saving (and clobbering) `worktreeEnvNotes` before the
    // fetch that seeds `existingOverrides` / `envDraft` has completed.
    const [envLoaded, setEnvLoaded] = useState(false);

    // Fetch detected environments + current overrides each time the dialog
    // opens (cheap, and keeps it fresh if the user just `npm install`ed).
    useEffect(() => {
      if (!open || !activeFolder) return;
      let cancelled = false;
      setEnvLoading(true);
      setEnvLoaded(false);
      Promise.all([fetchProjectEnv(activeFolder), fetchUserSettings(activeFolder)])
        .then(([envResp, settings]) => {
          if (cancelled) return;
          const overrides = settings.worktreeEnvNotes ?? {};
          setEnvs(envResp.environments);
          setExistingOverrides(overrides);
          setEnvDraft(
            Object.fromEntries(envResp.environments.map((e) => [e.id, e.effectiveNote])),
          );
          setEnvLoaded(true);
        })
        .finally(() => {
          if (!cancelled) setEnvLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, [open, activeFolder]);

    // Build the `worktreeEnvNotes` map to persist: start from whatever's
    // already saved (so overrides for undetected envs survive), then for each
    // detected env drop the key when the text equals the built-in default,
    // otherwise store the edited text (an empty string deliberately suppresses
    // the note for that env).
    const buildEnvNotesPatch = (): Record<string, string> => {
      const next: Record<string, string> = { ...existingOverrides };
      for (const env of envs) {
        const text = envDraft[env.id] ?? env.effectiveNote;
        if (text.trim() === env.defaultNote.trim()) {
          delete next[env.id];
        } else {
          next[env.id] = text;
        }
      }
      return next;
    };

    useImperativeHandle(
      ref,
      () => ({
        getWorktreeEnvNotesPatch: () => (envLoaded ? buildEnvNotesPatch() : undefined),
      }),
      [envLoaded, existingOverrides, envs, envDraft],
    );

    if (!active) return null;

    return (
      <div className="settings-section">
        <div className="settings-section-header">
          <div>
            <div className="settings-section-title">Worktree environment notes</div>
            <div className="settings-section-sub">
              Each task runs in a throwaway git worktree where gitignored
              dependency dirs (<code>node_modules</code>, <code>.venv</code>,
              <code> target</code>, …) aren’t checked out. When Lattice detects
              a package manager it prepends a short note to that task’s{' '}
              <code>LATTICE_TASK.md</code> (and <code> MERGE_INSTRUCTIONS.md</code>)
              telling the agent not to reinstall unless the task actually needs
              it — saving the agent from deliberating and running{' '}
              <code>install</code>. Edit the note below, or clear the box to
              remove it entirely.
            </div>
          </div>
        </div>
        {envLoading ? (
          <div className="settings-empty">Loading…</div>
        ) : envs.length === 0 ? (
          <div className="settings-empty">
            No package-manager environments detected at this project’s root —
            Lattice doesn’t add anything to task instructions here.
          </div>
        ) : (
          <div className="env-note-list">
            {envs.map((env) => {
              const text = envDraft[env.id] ?? env.effectiveNote;
              const isDefault = text.trim() === env.defaultNote.trim();
              const disabled = text.trim().length === 0;
              return (
                <div key={env.id} className="env-note-card">
                  <div className="env-note-card-header">
                    <div className="env-note-card-title">
                      {env.label}
                      <span className="env-note-card-manager">{env.manager}</span>
                      <span className="env-note-card-dir">{env.heavyDir}/</span>
                    </div>
                    <button
                      className="btn-ghost"
                      disabled={isDefault}
                      onClick={() =>
                        setEnvDraft((d) => ({ ...d, [env.id]: env.defaultNote }))
                      }
                      title="Reset to Lattice's default note"
                    >
                      <RotateCcw size={12} />
                      Reset
                    </button>
                  </div>
                  <textarea
                    className="text-input env-note-textarea"
                    value={text}
                    spellCheck={false}
                    rows={5}
                    placeholder="(empty — no note will be added for this environment)"
                    onChange={(e) =>
                      setEnvDraft((d) => ({ ...d, [env.id]: e.target.value }))
                    }
                  />
                  <div className="env-note-card-hint">
                    {disabled
                      ? 'Disabled — nothing will be injected for this environment.'
                      : isDefault
                        ? 'Using Lattice’s default note.'
                        : 'Customized.'}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  },
);
