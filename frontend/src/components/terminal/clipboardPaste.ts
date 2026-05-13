import type { Terminal } from '@xterm/xterm';

export function attachClipboardPasteHandler(term: Terminal) {
  // Ctrl+V (and Ctrl+Shift+V) → paste from clipboard. xterm's default is
  // to forward ^V as a raw byte to the pty, which is useless in interactive
  // tools like Claude Code. We intercept and call term.paste() so the
  // pasted text flows through onData → ws like normal typed input.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    const isPaste =
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      (event.key === 'v' || event.key === 'V');
    if (isPaste) {
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch(() => {
          /* clipboard unavailable — silently ignore */
        });
      event.preventDefault();
      return false;
    }
    return true;
  });
}
