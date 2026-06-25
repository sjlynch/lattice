import { useEffect } from 'react';
import type { RefObject } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { WebglAddon } from '@xterm/addon-webgl';
import { attachClipboardPasteHandler } from './clipboardPaste';
import { TERMINAL_OPTIONS } from './terminalConfig';

type UseTerminalLifecycleArgs = {
  containerRef: RefObject<HTMLDivElement | null>;
  termRef: RefObject<Terminal | null>;
  fitRef: RefObject<FitAddon | null>;
  webglRef: RefObject<WebglAddon | null>;
  cwd: string;
};

export function useTerminalLifecycle({
  containerRef,
  termRef,
  fitRef,
  webglRef,
  cwd,
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

    const ro = new ResizeObserver(() => {
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
      // the GL context is released cleanly.
      try {
        webglRef.current?.dispose();
      } catch {
        /* ignore */
      }
      webglRef.current = null;
      term.dispose();
    };
    // serverId is intentionally NOT a dependency: capturing a backend session
    // id is an attach detail and must not dispose+recreate the Terminal/FitAddon
    // (which clears the screen, drops focus, and churns a WebGL context). The
    // single Terminal lives for the pane's whole life. See terminal/CLAUDE.md.
  }, [containerRef, cwd, fitRef, termRef, webglRef]);
}
