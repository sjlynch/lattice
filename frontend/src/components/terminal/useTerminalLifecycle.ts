import { useEffect } from 'react';
import type { RefObject } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { WebglAddon } from '@xterm/addon-webgl';
import { attachClipboardPasteHandler } from './clipboardPaste';
import { TERMINAL_OPTIONS } from './terminalConfig';
import { disposeTerminalWebgl } from './terminalWebgl';

type UseTerminalLifecycleArgs = {
  containerRef: RefObject<HTMLDivElement | null>;
  termRef: RefObject<Terminal | null>;
  fitRef: RefObject<FitAddon | null>;
  webglRef: RefObject<WebglAddon | null>;
  cwd: string;
  // Whether this pane is the visible tab. Read live from the resize observer
  // (a ref, so a tab switch never re-runs the mount effect).
  activeRef: RefObject<boolean>;
};

export function useTerminalLifecycle({
  containerRef,
  termRef,
  fitRef,
  webglRef,
  cwd,
  activeRef,
}: UseTerminalLifecycleArgs) {
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal(TERMINAL_OPTIONS);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    // WebglAddon is attached lazily (only while this pane is `active`) by
    // useActiveTerminalWebgl. Each WebGL context counts toward Chrome's
    // per-page cap (~16); holding one per terminal made Run-All blow past it.
    fit.fit();
    fitRef.current = fit;
    termRef.current = term;
    attachClipboardPasteHandler(term);

    // Inactive panes are `visibility: hidden`, not `display: none` — they keep
    // their layout size, so a sidebar drag fires this observer on EVERY mounted
    // pane per pointer move. Each fit reflows that xterm's buffer and (via
    // onResize) queues a pty resize, which for a Codex session means a full
    // transcript re-emit. Only the visible pane tracks the container live;
    // a pane refits once when it becomes active (useActiveTerminalWebgl).
    const ro = new ResizeObserver(() => {
      if (!activeRef.current) return;
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      termRef.current = null;
      fitRef.current = null;
      // Dispose any live WebglAddon before tearing down the Terminal so
      // the GL context is released cleanly. This cleanup runs before
      // useActiveTerminalWebgl's, so it must release the canvases too.
      disposeTerminalWebgl(webglRef);
      term.dispose();
    };
    // serverId is intentionally NOT a dependency: capturing a backend session
    // id is an attach detail and must not dispose+recreate the Terminal/FitAddon
    // (which clears the screen, drops focus, and churns a WebGL context). The
    // single Terminal lives for the pane's whole life. See terminal/CLAUDE.md.
  }, [containerRef, cwd, fitRef, termRef, webglRef, activeRef]);
}
