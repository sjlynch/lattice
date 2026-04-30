import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { FolderPicker } from './FolderPicker';

type Props = {
  activeFolder: string;
  onSelectFolder: (path: string) => void;
};

export function TopAppBar({ activeFolder, onSelectFolder }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const folderName = activeFolder
    ? activeFolder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || activeFolder
    : '(no folder)';

  return (
    <>
      <header className="appbar">
        <div className="appbar-brand">Lattice</div>
        <div className="appbar-folder">
          <span className="appbar-folder-name">{folderName}</span>
          <button
            className="icon-btn sm"
            onClick={() => setPickerOpen(true)}
            title="Select active folder"
            aria-label="Select active folder"
          >
            <FolderOpen size={14} />
          </button>
          <span className="appbar-folder-path" title={activeFolder}>
            {activeFolder}
          </span>
        </div>
      </header>
      <FolderPicker
        open={pickerOpen}
        initialPath={activeFolder}
        onClose={() => setPickerOpen(false)}
        onSelect={(p) => {
          setPickerOpen(false);
          onSelectFolder(p);
        }}
      />
    </>
  );
}
