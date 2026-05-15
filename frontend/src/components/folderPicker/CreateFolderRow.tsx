import { FolderPlus } from 'lucide-react';

type CreateFolderRowProps = {
  newFolderName: string;
  onNewFolderNameChange: (name: string) => void;
  creating: boolean;
  canCreate: boolean;
  onCreateFolder: () => void;
};

export function CreateFolderRow({
  newFolderName,
  onNewFolderNameChange,
  creating,
  canCreate,
  onCreateFolder,
}: CreateFolderRowProps) {
  return (
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
  );
}
