import { ArrowUp } from 'lucide-react';

type PathRowProps = {
  pathInput: string;
  onPathInputChange: (path: string) => void;
  canGoUp: boolean;
  onUp: () => void;
  onGo: () => void;
};

export function PathRow({ pathInput, onPathInputChange, canGoUp, onUp, onGo }: PathRowProps) {
  return (
    <div className="path-row">
      <button
        className="icon-btn"
        onClick={onUp}
        disabled={!canGoUp}
        title="Up one level"
        aria-label="Up one level"
      >
        <ArrowUp size={14} />
      </button>
      <input
        className="text-input"
        value={pathInput}
        onChange={(e) => onPathInputChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onGo();
        }}
        spellCheck={false}
      />
      <button className="btn-ghost" onClick={onGo}>
        Go
      </button>
    </div>
  );
}
