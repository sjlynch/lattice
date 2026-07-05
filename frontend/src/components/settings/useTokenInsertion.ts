import { useRef } from 'react';

// Cursor-aware `{{token}}` insertion for a template editor's textarea. Drops
// the token at the caret (or replaces the current selection) so users can add a
// token without hand-typing the braces, then restores focus and places the
// caret just after the inserted token. Falls back to appending when the
// textarea ref isn't mounted yet.
export function useTokenInsertion(draft: string, onChange: (text: string) => void) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const insertToken = (name: string) => {
    const el = textareaRef.current;
    const snippet = `{{${name}}}`;
    if (!el) {
      onChange(draft + snippet);
      return;
    }
    const start = el.selectionStart ?? draft.length;
    const end = el.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + snippet + draft.slice(end);
    onChange(next);
    // Restore focus + place the caret after the inserted token.
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + snippet.length;
      el.setSelectionRange(pos, pos);
    });
  };

  return { textareaRef, insertToken };
}
