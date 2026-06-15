import { FileText, Search, X } from 'lucide-react';
import type { SearchStatus } from './hooks/useGraphSearch';

type Props = {
  query: string;
  onQueryChange: (q: string) => void;
  regex: boolean;
  onRegexToggle: () => void;
  contents: boolean;
  onContentsToggle: () => void;
  status: SearchStatus;
};

// Inline search field shown bottom-left of the graph, to the left of the
// file/dir counts. Matches (filename + contents) are rendered as the standard
// selection ring via the shared `selected` set. The `.*` button toggles
// raw-regex vs wildcard interpretation.
export function GraphSearchBar({
  query,
  onQueryChange,
  regex,
  onRegexToggle,
  contents,
  onContentsToggle,
  status,
}: Props) {
  const syntax = regex ? 'Regex' : 'Wildcard (* and ?)';
  return (
    <div className={`graph-search${status.invalidRegex ? ' invalid' : ''}`}>
      <Search size={13} className="graph-search-icon" />
      <input
        className="graph-search-input"
        type="text"
        value={query}
        placeholder="Search files…"
        spellCheck={false}
        autoComplete="off"
        aria-label="Search files by name or contents"
        title={`${syntax} search — file names${
          contents ? ' + contents' : ' (names only; toggle the file icon for contents)'
        }`}
        onChange={(e) => onQueryChange(e.target.value)}
        // Keep graph hold-key overlays (h/z/d/w/Alt) and the Escape
        // selection-clear from firing while typing. The overlay handlers
        // already bail on isTextInput; stopPropagation covers Escape (which we
        // repurpose to clear the query) and is belt-and-suspenders for the rest.
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query) {
            onQueryChange('');
            e.stopPropagation();
          }
        }}
      />
      {status.active && (
        <span className="graph-search-count">
          {status.searching && <span className="spinner" />}
          {status.invalidRegex
            ? 'bad regex'
            : `${status.matchCount}${status.truncated ? '+' : ''}`}
        </span>
      )}
      {query && (
        <button
          className="graph-search-clear"
          onClick={() => onQueryChange('')}
          title="Clear search (Esc)"
          aria-label="Clear search"
        >
          <X size={12} />
        </button>
      )}
      <button
        className={`graph-search-contents${contents ? ' active' : ''}`}
        onClick={onContentsToggle}
        title="Also search file contents (slower)"
        aria-label="Toggle file-contents search"
        aria-pressed={contents}
      >
        <FileText size={13} />
      </button>
      <button
        className={`graph-search-regex${regex ? ' active' : ''}`}
        onClick={onRegexToggle}
        title="Use regular expression"
        aria-label="Toggle regular expression mode"
        aria-pressed={regex}
      >
        .*
      </button>
    </div>
  );
}
