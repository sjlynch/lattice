import { HardDrive } from 'lucide-react';
import type { DirRoot } from '../../api';
import { rootKey } from './rootKey';

type DriveSelectorProps = {
  roots: DirRoot[];
  activeRoot: string;
  onSelect: (path: string) => void;
};

export function DriveSelector({ roots, activeRoot, onSelect }: DriveSelectorProps) {
  if (roots.length <= 1) return null;

  return (
    <div className="drive-row" aria-label="Available drives">
      <span className="drive-row-label">Drives</span>
      <div className="drive-list">
        {roots.map((root) => (
          <button
            key={root.path}
            className={`drive-chip${rootKey(root.path) === activeRoot ? ' active' : ''}`}
            onClick={() => onSelect(root.path)}
            title={root.path}
          >
            <HardDrive size={12} />
            {root.name}
          </button>
        ))}
      </div>
    </div>
  );
}
