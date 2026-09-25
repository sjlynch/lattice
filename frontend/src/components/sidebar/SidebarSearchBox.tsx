import { Search, X } from 'lucide-react';
import type { KeyboardEvent, RefObject } from 'react';
import { HEADER_ICON_SIZE } from './constants';

type Props = {
  filter: string;
  setFilter: (filter: string) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
};

// Inline terminal-search field in the sidebar header; filtering and the
// Escape-clears behavior live in hooks/useTerminalSearch.
export function SidebarSearchBox({ filter, setFilter, searchInputRef, onKeyDown }: Props) {
  return (
    <div className="sidebar-search">
      <Search size={HEADER_ICON_SIZE} className="sidebar-search-icon" />
      <input
        ref={searchInputRef}
        className="sidebar-search-input"
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search terminals…"
        aria-label="Search terminals"
      />
      {filter && (
        <button
          className="icon-btn sm sidebar-search-clear"
          onClick={() => setFilter('')}
          title="Clear search"
          aria-label="Clear search"
        >
          <X size={HEADER_ICON_SIZE} />
        </button>
      )}
    </div>
  );
}
