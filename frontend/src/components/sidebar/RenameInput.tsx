import { useRef, useState } from 'react';

// Mounts fresh each time a rename begins, seeding the draft from the current
// label (replacing the parent's old setDraft-on-startRename). The doneRef guard
// keeps the exact rename semantics: Enter or blur commits once, Escape cancels
// without committing — even though unmounting the focused input also fires blur.
export function RenameInput({
  initialLabel,
  onCommit,
  onCancel,
}: {
  initialLabel: string;
  onCommit: (label: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialLabel);
  const doneRef = useRef(false);

  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(draft);
  };
  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  };

  return (
    <input
      className="sidebar-tab-rename"
      value={draft}
      autoFocus
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      }}
      aria-label="Rename terminal"
    />
  );
}
