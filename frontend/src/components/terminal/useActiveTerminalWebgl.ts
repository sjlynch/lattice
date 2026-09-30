import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';
import { attachTerminalWebgl, disposeTerminalWebgl } from './terminalWebgl';

type UseActiveTerminalWebglArgs = {
  active: boolean;
  termRef: RefObject<Terminal | null>;
  fitRef: RefObject<FitAddon | null>;
  webglRef: RefObject<WebglAddon | null>;
  cwd: string;
};

export function useActiveTerminalWebgl({
  active,
  termRef,
  fitRef,
  webglRef,
  cwd,
}: UseActiveTerminalWebglArgs) {
  // Hold a WebGL context only while this pane is the active tab. Inactive
  // panes fall back to xterm's built-in DOM renderer (no GL resource), so
  // having many tabs open no longer multiplies WebGL contexts.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    if (active) {
      if (!webglRef.current) {
        attachTerminalWebgl<WebglAddon>(term, webglRef, () => new WebglAddon());
      }
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      term.focus();
      return () => disposeTerminalWebgl(webglRef);
    }

    if (webglRef.current) disposeTerminalWebgl(webglRef);
    // serverId is intentionally NOT a dependency — capturing a session id must
    // not dispose+reattach the WebGL context (a needless GL-context churn that
    // fights Chrome's per-page cap). Only `active` gates the context.
  }, [active, cwd, fitRef, termRef, webglRef]);
}
