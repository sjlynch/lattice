import { FolderPlus } from 'lucide-react';

type CreateFolderRowProps = {
  newFolderName: string;
  onNewFolderNameChange: (name: string) => void;
  creating: boolean;
  canCreate: boolean;
  initGit: boolean;
  onInitGitChange: (next: boolean) => void;
  onCreateFolder: () => void;
};

export function CreateFolderRow({
  newFolderName,
  onNewFolderNameChange,
  creating,
  canCreate,
  initGit,
  onInitGitChange,
  onCreateFolder,
}: CreateFolderRowProps) {
  return (
    <div className="create-folder-block">
      <div className="create-folder-row">
        <input
          className="text-input create-folder-input"
          value={newFolderName}
          onChange={(e) => onNewFolderNameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCreateFolder();
          }}
          placeholder="New folder name"
          disabled={!canCreate || creating}
          spellCheck={false}
        />
        <button
          className="btn-ghost"
          onClick={onCreateFolder}
          disabled={!canCreate || creating || !newFolderName.trim()}
        >
          <FolderPlus size={14} />
          {creating ? 'Creating…' : 'Create folder'}
        </button>
      </div>
      {/* Default checked: a brand-new folder is the "start a new project" case,
          and a Lattice project without a repo can't run a single task. */}
      <label className="create-folder-git">
        <input
          type="checkbox"
          checked={initGit}
          disabled={!canCreate || creating}
          onChange={(e) => onInitGitChange(e.target.checked)}
        />
        <span>Initialize a git repo</span>
      </label>
    </div>
  );
}
