import { forwardRef, useImperativeHandle } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  fetchProjectEnv,
  type ProjectEnvInfo,
  type ProjectEnvResponse,
  type UserSettings,
} from '../../api';
import { useOverrideDraft } from './useOverrideDraft';

type Props = {
  active: boolean;
  open: boolean;
  activeFolder: string;
};

export type EnvNotesTabHandle = {
  getWorktreeEnvNotesPatch: () => Record<string, string> | undefined;
};

type EnvNotesDraft = {
  envs: ProjectEnvInfo[];
  envDraft: Record<string, string>;
  envLoading: boolean;
  getWorktreeEnvNotesPatch: () => Record<string, string> | undefined;
  resetEnvDraft: (env: ProjectEnvInfo) => void;
  updateEnvDraft: (id: string, text: string) => void;
};

// Stable (module-level) config for the shared override-draft engine. A note
// drops its override key — falling back to Lattice's default — when its
// trimmed text equals the default note's; a blank-but-nondefault note is kept
// as `''`, deliberately suppressing the note for that env.
const fetchItems = (projectPath: string): Promise<ProjectEnvInfo[]> =>
  fetchProjectEnv(projectPath).then((r: ProjectEnvResponse) => r.environments);
const idOf = (e: ProjectEnvInfo) => e.id;
const defaultOf = (e: ProjectEnvInfo) => e.defaultNote;
const currentOf = (e: ProjectEnvInfo) => e.effectiveNote;
const readOverrides = (s: UserSettings) => s.worktreeEnvNotes ?? {};
const matchesDefault = (draft: string, e: ProjectEnvInfo) =>
  draft.trim() === e.defaultNote.trim();

function useEnvNotesDraft(open: boolean, active: boolean, activeFolder: string): EnvNotesDraft {
  const {
    items: envs,
    draftMap: envDraft,
    loading: envLoading,
    setDraft: updateEnvDraft,
    resetDraft: resetEnvDraft,
    getPatch: getWorktreeEnvNotesPatch,
  } = useOverrideDraft<ProjectEnvInfo>({
    open,
    active,
    activeFolder,
    fetchItems,
    readOverrides,
    idOf,
    defaultOf,
    currentOf,
    matchesDefault,
  });

  return {
    envs,
    envDraft,
    envLoading,
    getWorktreeEnvNotesPatch,
    resetEnvDraft,
    updateEnvDraft,
  };
}

type EnvNoteCardProps = {
  env: ProjectEnvInfo;
  text: string;
  onReset: (env: ProjectEnvInfo) => void;
  onTextChange: (id: string, text: string) => void;
};

function EnvNoteCard({ env, text, onReset, onTextChange }: EnvNoteCardProps) {
  const isDefault = text.trim() === env.defaultNote.trim();
  const disabled = text.trim().length === 0;

  return (
    <div className="env-note-card">
      <div className="env-note-card-header">
        <div className="env-note-card-title">
          {env.label}
          <span className="env-note-card-manager">{env.manager}</span>
          <span className="env-note-card-dir">{env.heavyDir}/</span>
        </div>
        <button
          className="btn-ghost"
          disabled={isDefault}
          onClick={() => onReset(env)}
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
        onChange={(e) => onTextChange(env.id, e.target.value)}
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
}

export const EnvNotesTab = forwardRef<EnvNotesTabHandle, Props>(
  function EnvNotesTab({ active, open, activeFolder }, ref) {
    const {
      envs,
      envDraft,
      envLoading,
      getWorktreeEnvNotesPatch,
      resetEnvDraft,
      updateEnvDraft,
    } = useEnvNotesDraft(open, active, activeFolder);

    useImperativeHandle(
      ref,
      () => ({ getWorktreeEnvNotesPatch }),
      [getWorktreeEnvNotesPatch],
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
              <code>install</code>. This is what fills the{' '}
              <code>{'{{env_notes_block}}'}</code> token in the templates above.
              Edit the note below, or clear the box to remove it entirely.
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
            {envs.map((env) => (
              <EnvNoteCard
                key={env.id}
                env={env}
                text={envDraft[env.id] ?? env.effectiveNote}
                onReset={resetEnvDraft}
                onTextChange={updateEnvDraft}
              />
            ))}
          </div>
        )}
      </div>
    );
  },
);
