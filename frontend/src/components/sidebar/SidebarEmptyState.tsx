import { GitMerge, Plus, Rocket, TerminalSquare } from 'lucide-react';
import type { Panel } from './hooks/usePanelState';

type Props = {
  activePanel: Panel;
  activeFolder: string;
};

export function SidebarEmptyState({ activePanel, activeFolder }: Props) {
  return (
    <div className="sidebar-empty">
      <div className="sidebar-empty-icon">
        {activePanel === 'merging' ? (
          <GitMerge size={22} />
        ) : activePanel === 'startup' ? (
          <Rocket size={22} />
        ) : (
          <TerminalSquare size={22} />
        )}
      </div>
      <div className="sidebar-empty-title">
        {activePanel === 'merging'
          ? 'No merge resolvers'
          : activePanel === 'startup'
            ? 'No startup terminals'
            : 'No terminals yet'}
      </div>
      {activePanel === 'terminals' && (
        <div className="sidebar-empty-sub">
          Click <Plus size={11} style={{ verticalAlign: -1 }} /> above to
          start a Claude Code shell rooted at <code>{activeFolder}</code>,
          or hit ▶ on a task to spawn one in a worktree.
        </div>
      )}
      {activePanel === 'startup' && (
        <div className="sidebar-empty-sub">
          Configure commands that auto-run on page load via the gear
          icon in the top bar.
        </div>
      )}
    </div>
  );
}
