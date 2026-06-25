import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';

type Props = {
  // Accessible name for the trigger button, e.g. "About the new terminal
  // default". Also the hover title.
  label: string;
  children: ReactNode;
};

// A small "(i)" info button that toggles a popover holding longer explanatory
// copy, so the settings dialog can keep its always-visible text terse. Closes on
// Escape (without closing the surrounding Modal — see the capture-phase handler)
// and on outside click; the button carries aria-expanded / aria-controls.
export function SettingsInfo({ label, children }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    // Capture phase + stopPropagation so Escape dismisses just this popover; the
    // Modal's own bubble-phase Escape handler (which would close the whole
    // dialog) never sees the event while the popover is open.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <span className="settings-info" ref={wrapRef}>
      <button
        type="button"
        className={`settings-info-btn${open ? ' open' : ''}`}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        <Info size={13} aria-hidden />
      </button>
      {open && (
        <span id={popoverId} role="note" className="settings-info-popover">
          {children}
        </span>
      )}
    </span>
  );
}
