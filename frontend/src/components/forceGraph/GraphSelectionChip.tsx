type Props = {
  count: number;
  onClear: () => void;
};

// Floating chip that surfaces the size of the current node selection
// and a clear-out shortcut. Hidden when nothing is selected.
export function GraphSelectionChip({ count, onClear }: Props) {
  if (count === 0) return null;
  return (
    <div className="graph-selection-chip">
      <span>
        {count} {count === 1 ? 'file' : 'files'} selected
      </span>
      <span className="sep">·</span>
      <button className="link-btn" onClick={onClear} title="Clear selection (Esc)">
        clear
      </button>
    </div>
  );
}
