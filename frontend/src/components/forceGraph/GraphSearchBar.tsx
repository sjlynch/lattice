import { memo } from 'react';
import { ChevronLeft, ChevronRight, FileText, Search, X } from 'lucide-react';
import type { SearchStatus } from './hooks/useGraphSearch';

type Props = {
  query: string;
  onQueryChange: (q: string) => void;
  regex: boolean;
  onRegexToggle: () => void;
  contents: boolean;
  onContentsToggle: () => void;
  status: SearchStatus;
  // 1-based index of the currently-focused match (0 = no current match yet).
  matchPosition: number;
  onPrevMatch: () => void;
  onNextMatch: () => void;
};

// Inline search field shown bottom-left of the graph, to the left of the
// file/dir counts. Matches (filename + contents) are rendered as the standard
// selection ring via the shared `selected` set. The `.*` button toggles
// raw-regex vs wildcard interpretation.
export const GraphSearchBar = memo(function GraphSearchBar({
  query,
  onQueryChange,
  regex,
  onRegexToggle,
  contents,
  onContentsToggle,
  status,
  matchPosition,
  onPrevMatch,
  onNextMatch,
}: Props) {
  const syntax = regex ? 'Regex' : 'Wildcard (* and ?)';
  // A query that ran but selected nothing — distinct from idle so "0" doesn't
  // read like the search never fired. Only once the (debounced) contents pass
  // has settled, so it doesn't flash before backend matches arrive.
  const noMatches =
    status.active &&
    status.matchCount === 0 &&
    !status.invalidRegex &&
    !status.searching;
  // Prev/next stepping is available once there's at least one real match.
  const canNavigate = status.active && status.matchCount > 0 && !status.invalidRegex;
  const countLabel = status.invalidRegex
    ? 'bad regex'
    : noMatches
      ? 'no matches'
      : matchPosition > 0
        ? `${matchPosition} of ${status.matchCount}${status.truncated ? '+' : ''}`
        : `${status.matchCount}${status.truncated ? '+' : ''}`;
  return (
    <div className="graph-search-shell">
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
          // Enter steps to the next match (Shift+Enter the previous) — browser
          // find-bar muscle memory — so the user can cycle without the mouse.
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              onQueryChange('');
              e.stopPropagation();
            } else if (e.key === 'Enter' && canNavigate) {
              if (e.shiftKey) onPrevMatch();
              else onNextMatch();
              e.preventDefault();
              e.stopPropagation();
            }
          }}
        />
        {status.active && (
          <span className="graph-search-nav">
            {canNavigate && (
              <button
                className="graph-search-step"
                onClick={onPrevMatch}
                title="Previous match (Shift+Enter)"
                aria-label="Previous match"
              >
                <ChevronLeft size={12} />
              </button>
            )}
            <span className={`graph-search-count${noMatches ? ' none' : ''}`}>
              {status.searching && <span className="spinner" />}
              {countLabel}
            </span>
            {canNavigate && (
              <button
                className="graph-search-step"
                onClick={onNextMatch}
                title="Next match (Enter)"
                aria-label="Next match"
              >
                <ChevronRight size={12} />
              </button>
            )}
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
      {status.error && (
        <div className="graph-search-error error-msg" role="alert" title={status.error}>
          {status.error}
        </div>
      )}
    </div>
  );
});
