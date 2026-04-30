import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

type Props = {
  cwd: string;
  active: boolean;
  initialCommand?: string;
};

export function TerminalPane({ cwd, active, initialCommand }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);

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

    const params = new URLSearchParams({
      cwd,
      cols: String(term.cols),
      rows: String(term.rows),
    });
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${proto}://${window.location.host}/ws/terminal?${params.toString()}`,
    );

    let initialSent = false;
    function maybeSendInitial() {
      if (initialSent || !initialCommand) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      initialSent = true;
      // Slight delay so the shell prompt is ready before we type.
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'input', data: initialCommand + '\r' }));
      }, 250);
    }

    ws.onopen = () => {
      maybeSendInitial();
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'data') term.write(msg.data);
        else if (msg.type === 'error')
          term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
        else if (msg.type === 'exit')
          term.write(`\r\n\x1b[2m[exited ${msg.exitCode}]\x1b[0m\r\n`);
      } catch {
        // ignore
      }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // ignore
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      ws.close();
      term.dispose();
    };
  }, [cwd, initialCommand]);

  useEffect(() => {
    if (active && fitRef.current) {
      try {
        fitRef.current.fit();
      } catch {
        // ignore
      }
    }
  }, [active]);

  return <div ref={containerRef} className="term-pane" />;
}
