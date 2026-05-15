import { Eye, EyeOff } from 'lucide-react';
import { ShapePreview } from './ShapePreview';
import type { LegendRowData } from './useLegendRows';

type Props = {
  row: LegendRowData;
  hidden: boolean;
  onToggle: () => void;
  muted?: boolean;
};

export function LegendRow({ row, hidden, onToggle, muted }: Props) {
  return (
    <button
      className={`legend-row ${hidden ? 'hidden' : ''} ${muted ? 'muted' : ''}`}
      onClick={onToggle}
      title={hidden ? 'Click to show' : 'Click to hide'}
    >
      <ShapePreview style={row.style} size={14} />
      <span className="legend-row-ext">{row.style.ext}</span>
      <span className="legend-row-label">{row.label}</span>
      <span className="legend-row-count">{row.count > 0 ? row.count : ''}</span>
      <span className="legend-row-eye">
        {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
      </span>
    </button>
  );
}
