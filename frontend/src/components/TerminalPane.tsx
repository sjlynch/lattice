import { useRef } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useActiveTerminalWebgl } from './terminal/useActiveTerminalWebgl';
import { useTerminalConnection } from './terminal/useTerminalConnection';
import { useTerminalLifecycle } from './terminal/useTerminalLifecycle';

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

  useTerminalLifecycle({ containerRef, termRef, fitRef, webglRef, cwd, serverId });
  useTerminalConnection({
    termRef,
    cwd,
    initialCommand,
    serverId,
    projectPath,
    onServerId,
  });
  useActiveTerminalWebgl({ active, termRef, fitRef, webglRef, cwd, serverId });

  return <div ref={containerRef} className="term-pane" />;
}
