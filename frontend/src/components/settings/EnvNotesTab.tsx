import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  fetchProjectEnv,
  fetchUserSettingsStrict,
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
  // `taskWorktreeLfsContent`, or undefined unless the user flipped the checkbox.
  getTaskWorktreeLfsContentPatch: () => 'pointers' | 'full' | undefined;
};

// The "LFS files as pointers" checkbox (`taskWorktreeLfsContent`, default
// 'pointers'). Seeded from the project settings on each open; only a user flip
// produces a patch, so a slow or failed GET can never write the default over a
// saved value.
function useTaskWorktreeLfsDraft(open: boolean, activeFolder: string) {
  const [pointers, setPointers] = useState(true);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!open || !activeFolder) return;
    let cancelled = false;
    setTouched(false);
    fetchUserSettingsStrict(activeFolder)
      .then((s) => {
        if (!cancelled) setPointers(s.taskWorktreeLfsContent !== 'full');
      })
      .catch(() => { /* untouched → no patch */ });
    return () => {
      cancelled = true;
    };
  }, [open, activeFolder]);
  const set = (value: boolean) => {
    setTouched(true);
    setPointers(value);
  };
  const patch: 'pointers' | 'full' | undefined = touched ? (pointers ? 'pointers' : 'full') : undefined;
  return { pointers, setPointers: set, patch };
}

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
    const lfs = useTaskWorktreeLfsDraft(open, activeFolder);
    const lfsPatch = lfs.patch;

    useImperativeHandle(
      ref,
      () => ({
        getWorktreeEnvNotesPatch,
        getTaskWorktreeLfsContentPatch: () => lfsPatch,
      }),
      [getWorktreeEnvNotesPatch, lfsPatch],
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
        <label className="settings-checkbox-row">
          <input
            type="checkbox"
            checked={lfs.pointers}
            onChange={(e) => lfs.setPointers(e.target.checked)}
          />
          <span>Task worktrees check out Git LFS files as pointers (saves disk)</span>
        </label>
        <div className="settings-section-sub">
          On (the default), a task worktree gets each Git LFS file as a small
          text pointer instead of its content — on an asset-heavy repo that is
          most of every checkout. The agent is told to run{' '}
          <code>git lfs pull --include="&lt;path&gt;"</code> for any file it
          actually needs. Merged work lands in the main checkout with real
          content as usual. Off, every worktree smudges its LFS files in full.
        </div>
        {envLoading ? (
          <div className="settings-empty">Loading…</div>
        ) : envs.length === 0 ? (
          <div className="settings-empty">
            No package-manager environments detected at this project’s root —
            Lattice adds no dependency note to task instructions here.
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
