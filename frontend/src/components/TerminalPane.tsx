import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
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
    fit.fit();
    fitRef.current = fit;

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

    function connect() {
      if (cancelled) return;
      const params = new URLSearchParams({
        cwd,
        cols: String(term.cols),
        rows: String(term.rows),
      });
      if (serverId) params.set('id', serverId);
      if (initialCommand) params.set('initialCommand', initialCommand);
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
          }
        } catch {
          /* ignore */
        }
      };

      ws.onerror = () => {
        // onclose will fire too; reconnect is scheduled there.
      };

      ws.onclose = () => {
        if (cancelled) return;
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

    connect();

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
      if (retryTimer) clearTimeout(retryTimer);
      ro.disconnect();
      // Just close the WS — the backend keeps the pty alive so a refresh
      // (or remount) reattaches via the persisted serverId.
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, serverId]);

  useEffect(() => {
    if (active && fitRef.current) {
      try {
        fitRef.current.fit();
      } catch {
        /* ignore */
      }
    }
  }, [active]);

  return <div ref={containerRef} className="term-pane" />;
}
