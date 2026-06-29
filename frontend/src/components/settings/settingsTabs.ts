import { BarChart3, Cpu, Plug, ScrollText, Server, TerminalSquare } from 'lucide-react';

export type Tab = 'terminals' | 'prompts' | 'metrics' | 'agents' | 'pi' | 'mcp';

// Scope tells the user whether a tab's settings are machine-global (apply to
// every project on this machine — Agents' max-agents, Pi endpoints/model menu)
// or per-project (only the active folder). Drives the per-tab scope badge.
export type TabScope = 'global' | 'project';

export const SETTINGS_TABS: {
  id: Tab;
  label: string;
  Icon: typeof TerminalSquare;
  scope: TabScope;
}[] = [
  { id: 'terminals', label: 'Terminals', Icon: TerminalSquare, scope: 'project' },
  { id: 'prompts', label: 'Agent prompts', Icon: ScrollText, scope: 'project' },
  { id: 'metrics', label: 'Metrics', Icon: BarChart3, scope: 'project' },
  { id: 'agents', label: 'Agents', Icon: Cpu, scope: 'global' },
  { id: 'pi', label: 'Pi', Icon: Server, scope: 'global' },
  { id: 'mcp', label: 'MCP', Icon: Plug, scope: 'project' },
];
