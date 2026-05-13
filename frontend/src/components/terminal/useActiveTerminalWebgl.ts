import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

type UseActiveTerminalWebglArgs = {
  active: boolean;
  termRef: RefObject<Terminal | null>;
  fitRef: RefObject<FitAddon | null>;
  webglRef: RefObject<WebglAddon | null>;
  cwd: string;
  serverId?: string;
};

function disposeWebgl(webglRef: RefObject<WebglAddon | null>) {
  try {
    webglRef.current?.dispose();
  } catch {
    /* ignore */
  }
  webglRef.current = null;
}

export function useActiveTerminalWebgl({
  active,
  termRef,
  fitRef,
  webglRef,
  cwd,
  serverId,
}: UseActiveTerminalWebglArgs) {
  // Hold a WebGL context only while this pane is the active tab. Inactive
  // panes fall back to xterm's built-in DOM renderer (no GL resource), so
  // having many tabs open no longer multiplies WebGL contexts.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    if (active) {
      if (!webglRef.current) {
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => {
            try {
              webgl.dispose();
            } catch {
              /* ignore */
            }
            if (webglRef.current === webgl) webglRef.current = null;
          });
          term.loadAddon(webgl);
          webglRef.current = webgl;
        } catch {
          // WebGL unavailable / context limit hit — DOM renderer stays.
        }
      }
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      term.focus();
      return () => disposeWebgl(webglRef);
    }

    if (webglRef.current) disposeWebgl(webglRef);
  }, [active, cwd, fitRef, serverId, termRef, webglRef]);
}
