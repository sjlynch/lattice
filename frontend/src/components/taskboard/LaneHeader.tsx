import {
  CheckCheck,
  Eye,
  EyeOff,
  GitMerge,
  Globe,
  Play,
  Plus,
  UploadCloud,
} from 'lucide-react';
import type { Task, TaskStatus } from '../../api';
import type { Lane as LaneDef } from './lanes';
import type { QaPlaywrightControls } from './hooks/useQaPlaywright';

type Props = {
  lane: LaneDef;
  tasks: Task[];
  onAdd: () => void;
  onRunAll?: () => void;
  // Lane-level "push to remote" action. The launcher passes this only on the
  // QA lane today; rendered as a small icon button next to the add (+) one.
  onPush?: () => void;
  pushDisabled?: boolean;
  // QA-lane Playwright MCP controls (launcher passes this only on the QA lane).
  qaPlaywright?: QaPlaywrightControls;
  // QA-lane "run an e2e test for every task". Passed only on the QA lane and
  // only when the Playwright MCP is on, so it sits in the Playwright cluster.
  onQaRunAll?: () => void;
};

// Lane header row: dot/title/count, lane-level run-all action, push, add.
// Extracted from Lane so the lane body stays focused on drop targets and
// card rendering.
export function LaneHeader({
  lane,
  tasks,
  onAdd,
  onRunAll,
  onPush,
  pushDisabled,
  qaPlaywright,
  onQaRunAll,
}: Props) {
  const runAllConfig = onRunAll ? laneRunAllConfig(lane.id, tasks) : null;

  return (
    <div className="taskboard-lane-head">
      <span className="taskboard-lane-title">
        <span
          className="taskboard-lane-dot"
          style={{ background: lane.color }}
        />
        {lane.label}
        <span className="taskboard-lane-count">{tasks.length}</span>
        {onRunAll && runAllConfig && (
          <button
            className={`lane-runall ${runAllConfig.cls}`}
            onClick={onRunAll}
            disabled={runAllConfig.disabled}
            title={runAllConfig.title}
            aria-label={runAllConfig.aria}
          >
            {runAllConfig.icon}
          </button>
        )}
      </span>
      <div className="taskboard-lane-actions">
        {qaPlaywright && (
          <>
            <button
              className={`icon-btn sm mcp-pw-btn ${qaPlaywright.enabled ? 'on' : ''}`}
              onClick={qaPlaywright.onToggleEnabled}
              title={
                qaPlaywright.enabled
                  ? 'Playwright MCP ON — injected into Claude sessions Lattice spawns for this project (takes effect on the next launch). Click to turn off.'
                  : 'Turn ON the Playwright MCP for this project’s Claude sessions (browser testing). Applies to the next launch.'
              }
              aria-label="Toggle Playwright MCP"
              aria-pressed={qaPlaywright.enabled}
            >
              <Globe size={14} />
            </button>
            {qaPlaywright.enabled && (
              <button
                className="icon-btn sm mcp-pw-btn"
                onClick={qaPlaywright.onToggleHeadless}
                title={
                  qaPlaywright.headless
                    ? 'Playwright runs HEADLESS (no visible browser). Click for headed. Takes effect on the next QA run, not one already started.'
                    : 'Playwright runs HEADED (visible browser window). Click for headless. Takes effect on the next QA run, not one already started.'
                }
                aria-label="Toggle Playwright headless mode"
                aria-pressed={qaPlaywright.headless}
              >
                {qaPlaywright.headless ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            )}
            {qaPlaywright.enabled && onQaRunAll && (
              <button
                className="icon-btn sm mcp-pw-btn qa-runall"
                onClick={onQaRunAll}
                disabled={tasks.length === 0}
                title="Run an end-to-end Playwright test for every QA task"
                aria-label="Run all QA end-to-end tests"
              >
                <Play size={13} fill="currentColor" />
              </button>
            )}
          </>
        )}
        {onPush && (
          <button
            className="icon-btn sm"
            onClick={onPush}
            disabled={pushDisabled}
            title={pushDisabled ? 'Push in progress…' : 'Push project to remote'}
            aria-label="Push project to remote"
          >
            <UploadCloud size={14} />
          </button>
        )}
        <button
          className="icon-btn sm"
          onClick={onAdd}
          title="Add task"
          aria-label="Add task"
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}

// Lane-specific bulk-action presentation. Centralized here so the JSX
// above stays focused on layout rather than per-lane copy.
function laneRunAllConfig(id: TaskStatus, tasks: Task[]) {
  switch (id) {
    case 'ready_to_merge':
      return {
        cls: 'merge',
        disabled: tasks.length === 0,
        title: 'Merge every Ready-to-Merge task (stops on first conflict)',
        aria: 'Merge all ready tasks',
        icon: <GitMerge size={11} />,
      };
    case 'in_progress':
      return {
        cls: 'resume',
        disabled: tasks.filter((t) => !!t.worktreePath).length === 0,
        title: 'Resume every In Progress task with an existing worktree',
        aria: 'Resume all in-progress tasks',
        icon: <Play size={11} fill="currentColor" />,
      };
    case 'qa':
      return {
        cls: 'qa-done',
        disabled: tasks.length === 0,
        title: 'Mark every QA task as Done',
        aria: 'Mark all QA tasks done',
        icon: <CheckCheck size={12} />,
      };
    case 'open':
      return {
        cls: '',
        disabled: tasks.length === 0,
        title: 'Run every task in Open in a new worktree',
        aria: 'Run all open tasks',
        icon: <Play size={11} fill="currentColor" />,
      };
    default:
      return null;
  }
}
