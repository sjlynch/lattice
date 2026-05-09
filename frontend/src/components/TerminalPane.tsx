import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

type Props = {
  cwd: string;
  active: boolean;
  initialCommand?: string;
  serverId?: string;
  projectPath?: string;
  onServerId?: (id: string) => void;
};

export function TerminalPane({
  cwd,
  active,
  initialCommand,
  serverId,
  projectPath,
  onServerId,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  // Keep latest callback in a ref so we don't re-establish the WS just
  // because the parent re-rendered.
  const onServerIdRef = useRef<typeof onServerId>(onServerId);
  useEffect(() => {
    onServerIdRef.current = onServerId;
  }, [onServerId]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        '"Cascadia Mono", "JetBrains Mono", Consolas, Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      letterSpacing: 0,
      allowProposedApi: true,
      scrollback: 5000,
      theme: {
        background: '#0e1014',
        foreground: '#e3e5e9',
        cursor: '#6aa9ff',
        cursorAccent: '#0e1014',
        selectionBackground: 'rgba(106,169,255,0.30)',
        black: '#0e1014',
        brightBlack: '#3d4350',
        red: '#ff8888',
        brightRed: '#ffa3a3',
        green: '#9ed28e',
        brightGreen: '#bce3ad',
        yellow: '#e7c986',
        brightYellow: '#f0d8a4',
        blue: '#6aa9ff',
        brightBlue: '#88bcff',
        magenta: '#c89cff',
        brightMagenta: '#dab8ff',
        cyan: '#83d6e3',
        brightCyan: '#a4e1ec',
        white: '#cfd2d8',
        brightWhite: '#ebecef',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    // WebglAddon is attached lazily (only while this pane is `active`) — see
    // the active-prop effect below. Each WebGL context counts toward Chrome's
    // per-page cap (~16); holding one per terminal made Run-All blow past it.
    fit.fit();
    fitRef.current = fit;
    termRef.current = term;

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

    let ws: WebSocket | null = null;
    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectingShown = false;
    // Once the pty has signalled it is gone (clean exit, or backend says
    // session_lost), stop reconnecting. Without this, every WS close —
    // including the one immediately following a clean pty exit — would
    // trigger a fresh connect, which on a deleted-worktree session
    // produces a feedback loop that spawns thousands of doomed ptys.
    let terminated = false;
    // Cap reconnect attempts. A genuine network blip recovers in 1-2
    // tries; six attempts (~7 s of backoff total) is plenty before we
    // declare the connection dead and stop hammering the backend.
    const MAX_RECONNECT_ATTEMPTS = 6;

    function connect() {
      if (cancelled || terminated) return;
      const params = new URLSearchParams({
        cwd,
        cols: String(term.cols),
        rows: String(term.rows),
      });
      if (serverId) params.set('id', serverId);
      // Only forward initialCommand when we're creating a fresh session.
      // For a known serverId the backend already ran the initial command
      // when it pre-spawned the pty; passing it again would be a no-op
      // (terminal.ts ignores it on replay) but it's needless noise.
      if (!serverId && initialCommand) params.set('initialCommand', initialCommand);
      if (projectPath) params.set('projectPath', projectPath);

      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(
        `${proto}://${window.location.host}/ws/terminal?${params.toString()}`,
      );

      ws.onopen = () => {
        attempt = 0;
        if (reconnectingShown) {
          term.write('\r\n\x1b[2m[reconnected]\x1b[0m\r\n');
          reconnectingShown = false;
        }
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'data') {
            term.write(msg.data);
          } else if (msg.type === 'attached') {
            if (msg.id && msg.id !== serverId) {
              onServerIdRef.current?.(msg.id);
            }
            if (msg.replayed === false) {
              // Brand new session — clear any leftover xterm content.
              term.clear();
            }
          } else if (msg.type === 'error') {
            term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
          } else if (msg.type === 'exit') {
            term.write(`\r\n\x1b[2m[exited ${msg.exitCode}]\x1b[0m\r\n`);
            // The pty is gone for good. Mark terminated so the WS close
            // that follows doesn't trigger a reconnect (which on a
            // cleaned-up worktree would create a doomed-to-exit pty,
            // feeding back into another close → another reconnect →
            // runaway).
            terminated = true;
          } else if (msg.type === 'session_lost') {
            term.write(
              `\r\n\x1b[2m[${msg.message ?? 'session lost'}]\x1b[0m\r\n`,
            );
            terminated = true;
          }
        } catch {
          /* ignore */
        }
      };

      ws.onerror = () => {
        // onclose will fire too; reconnect is scheduled there.
      };

      ws.onclose = () => {
        if (cancelled || terminated) return;
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
          term.write(
            '\r\n\x1b[31m[connection lost — gave up after ' +
              MAX_RECONNECT_ATTEMPTS +
              ' reconnect attempts. Close this tab and start a new terminal if needed.]\x1b[0m\r\n',
          );
          terminated = true;
          return;
        }
        if (!reconnectingShown) {
          term.write(
            '\r\n\x1b[2m[connection lost — reconnecting…]\x1b[0m\r\n',
          );
          reconnectingShown = true;
        }
        const delay = Math.min(5000, 250 * 2 ** attempt);
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      };
    }

    term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    term.onResize(({ cols, rows }) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    // Defer the actual connect by one task tick so React StrictMode's
    // synchronous cleanup (which sets cancelled=true) runs before we
    // initiate the WS handshake. Without this, the first effect run
    // opens a WS that the backend has already begun upgrading before
    // the cleanup can abort it — when we lack a serverId (a fresh
    // startup terminal), the backend creates a pty session that
    // outlives the cleanup. The second effect run then opens ANOTHER
    // serverless WS and creates a SECOND pty, both running the same
    // initialCommand. For port-binding commands like `npm run dev`,
    // the second fails with "address in use". This delay is also
    // production-safe — a 0 ms task hop is imperceptible.
    const connectTimer = setTimeout(connect, 0);

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    });
    ro.observe(containerRef.current);

    return () => {
      cancelled = true;
      clearTimeout(connectTimer);
      if (retryTimer) clearTimeout(retryTimer);
      ro.disconnect();
      // Just close the WS — the backend keeps the pty alive so a refresh
      // (or remount) reattaches via the persisted serverId.
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      termRef.current = null;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, serverId]);

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
    } else if (webglRef.current) {
      try {
        webglRef.current.dispose();
      } catch {
        /* ignore */
      }
      webglRef.current = null;
    }
  }, [active]);

  return <div ref={containerRef} className="term-pane" />;
}
