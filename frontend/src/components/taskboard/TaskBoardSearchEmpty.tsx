import { SearchX } from 'lucide-react';

type Props = {
  query: string;
  onClear: () => void;
};

// Shown in the board body when a search query is active but no tasks match —
// distinguishes "nothing matches your search" from a genuinely empty board.
// Only rendered for the active-search-zero-results case (see launcher gate);
// a neutral empty board is intentionally out of scope.
export function TaskBoardSearchEmpty({ query, onClear }: Props) {
  return (
    <div className="taskboard-search-empty" role="status">
      <SearchX size={28} aria-hidden />
      <div className="taskboard-search-empty-title">
        No tasks match{' '}
        <span className="taskboard-search-empty-query">“{query}”</span>
      </div>
      <button
        type="button"
        className="btn-ghost taskboard-search-empty-clear"
        onClick={onClear}
      >
        Clear search
      </button>
    </div>
  );
}
