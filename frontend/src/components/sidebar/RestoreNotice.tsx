import { X } from 'lucide-react';
import type { RestoreNotice as RestoreNoticeState } from '../../terminal/terminalTypes';

type Props = {
  activeFolder: string;
  // 'ask' mode: the registry has tabs to bring back and is waiting on the user.
  prompt: { count: number } | null;
  // The outcome of the last restore pass for this project.
  notice: RestoreNoticeState | null;
  onRestore: () => void;
  onDismiss: () => void;
};

export function describeRestoreSummary(summary: RestoreNoticeState['summary']): string {
  if (summary.status === 'terminal-server-unreachable') {
    return 'Could not restore tabs: the terminal server is unreachable.';
  }
  if (summary.status === 'already-running') {
    return 'A restore is already in progress — tabs relaunch as the concurrency cap allows.';
  }
  const parts: string[] = [];
  if (summary.adopted > 0) parts.push(`${summary.adopted} re-attached`);
  if (summary.queued > 0) parts.push(`${summary.queued} relaunching`);
  const total = summary.adopted + summary.queued;
  const head = total === 0
    ? 'Nothing to restore.'
    : `Restored ${total} tab${total === 1 ? '' : 's'} (${parts.join(', ')}).`;
  if (summary.dropped.length === 0) return head;
  const dropped = summary.dropped
    .map((d) => `${d.label}: ${d.reason}`)
    .join('; ');
  return `${head} ${summary.dropped.length} dropped — ${dropped}`;
}

// The thin strip under the sidebar header that (a) offers to restore tabs in
// 'ask' mode and (b) reports what the last restore did. Renders nothing when
// there is nothing to say.
export function RestoreNotice({ activeFolder, prompt, notice, onRestore, onDismiss }: Props) {
  if (prompt) {
    return (
      <div className="sidebar-restore-notice prompt" role="status">
        <span>
          {prompt.count} terminal tab{prompt.count === 1 ? '' : 's'} from your last session can be restored.
        </span>
        <button className="sidebar-restore-action" onClick={onRestore}>
          Restore
        </button>
      </div>
    );
  }
  if (!notice || notice.projectPath !== activeFolder) return null;
  const failed = notice.summary.status !== 'ok' || notice.summary.dropped.length > 0;
  return (
    <div className={`sidebar-restore-notice ${failed ? 'warn' : ''}`} role="status">
      <span>{describeRestoreSummary(notice.summary)}</span>
      <button
        className="icon-btn sm"
        onClick={onDismiss}
        title="Dismiss"
        aria-label="Dismiss restore notice"
      >
        <X size={11} />
      </button>
    </div>
  );
}
