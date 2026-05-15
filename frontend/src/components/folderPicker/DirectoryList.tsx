import { Folder } from 'lucide-react';
import type { DirEntry, DirListing } from '../../api';

type DirectoryListProps = {
  loading: boolean;
  listing: DirListing | null;
  onNavigate: (path: string) => void;
  onSelect: (path: string) => void;
};

type DirectoryRowProps = {
  entry: DirEntry;
  onNavigate: (path: string) => void;
  onSelect: (path: string) => void;
};

function DirectoryRow({ entry, onNavigate, onSelect }: DirectoryRowProps) {
  return (
    <div
      className="dir-row"
      onClick={() => onNavigate(entry.path)}
      onDoubleClick={() => onSelect(entry.path)}
    >
      <span className="dir-icon">
        <Folder size={14} />
      </span>
      <span>{entry.name}</span>
    </div>
  );
}

export function DirectoryList({ loading, listing, onNavigate, onSelect }: DirectoryListProps) {
  return (
    <div className="dir-list">
      {loading && !listing && (
        <div className="dir-list-empty">Loading…</div>
      )}
      {listing && listing.entries.length === 0 && (
        <div className="dir-list-empty">No subfolders here</div>
      )}
      {listing &&
        listing.entries.map((entry) => (
          <DirectoryRow
            key={entry.path}
            entry={entry}
            onNavigate={onNavigate}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}
