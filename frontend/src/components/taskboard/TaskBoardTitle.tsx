import { Kanban, Search, X } from 'lucide-react';

type Props = {
  taskSearch: string;
  setTaskSearch: (value: string) => void;
};

// FloatingPanel titlebar for the task board: the title label plus the
// case-insensitive search box (Escape clears, ✕ clears). `fp-no-drag` keeps
// the input usable inside the draggable titlebar.
export function TaskBoardTitle({ taskSearch, setTaskSearch }: Props) {
  return (
    <>
      <Kanban size={13} />
      <span>Task board</span>
      <div className="taskboard-search fp-no-drag">
        <Search size={12} aria-hidden />
        <input
          className="taskboard-search-input"
          value={taskSearch}
          onChange={(e) => setTaskSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && taskSearch) {
              e.stopPropagation();
              setTaskSearch('');
            }
          }}
          placeholder="Search tasks"
          aria-label="Search tasks"
        />
        {taskSearch && (
          <button
            type="button"
            className="taskboard-search-clear"
            onClick={() => setTaskSearch('')}
            title="Clear search"
            aria-label="Clear search"
          >
            <X size={11} />
          </button>
        )}
      </div>
    </>
  );
}
