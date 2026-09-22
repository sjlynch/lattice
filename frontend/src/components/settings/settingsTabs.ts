import {
  BarChart3,
  Cpu,
  Plug,
  ScrollText,
  Server,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react';

export type Tab = 'terminals' | 'prompts' | 'metrics' | 'agents' | 'pi' | 'mcp' | 'tools';

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
  // Engine + rule packs are machine-global; the per-project scan filter on the
  // same tab is the exception the tab's copy calls out.
  { id: 'tools', label: 'Tools', Icon: ShieldCheck, scope: 'global' },
];

// With no project open only the machine-global tabs are shown: the
// per-project ones have nowhere to load from or save to. (MCP is hidden too —
// its enables are per-project; its custom servers / keys can be managed once a
// project is open.)
export function visibleSettingsTabs(hasProject: boolean): typeof SETTINGS_TABS {
  return hasProject ? SETTINGS_TABS : SETTINGS_TABS.filter((t) => t.scope === 'global');
}

// The tab actually shown: the selected one if visible, else the first visible
// one (e.g. the default 'terminals' when Settings opens with no project).
export function resolveSettingsTab(tab: Tab, hasProject: boolean): Tab {
  const visible = visibleSettingsTabs(hasProject);
  return visible.some((t) => t.id === tab) ? tab : visible[0].id;
}
