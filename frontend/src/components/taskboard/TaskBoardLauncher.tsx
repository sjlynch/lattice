import { useState } from 'react';
import { Kanban } from 'lucide-react';
import { FloatingPanel } from '../FloatingPanel';
import { TaskBoardPanelBody } from './TaskBoardPanelBody';
import { TaskBoardTitle } from './TaskBoardTitle';
import { useTaskBoardController } from './hooks/useTaskBoardController';

type Props = {
  activeFolder: string;
};

// Top-level Task Board launcher: owns only the FAB and FloatingPanel chrome.
// TaskBoardPanelBody fans the controller into filters/lanes/overlays/footer.
export function TaskBoardLauncher({ activeFolder }: Props) {
  const [open, setOpen] = useState(false);
  const board = useTaskBoardController(activeFolder);

  return (
    <>
      <button
        className="fab"
        onClick={() => setOpen(true)}
        title="Open task board"
        aria-label="Open task board"
      >
        <Kanban size={15} />
        <span>Tasks</span>
        {board.activeCount > 0 && (
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              marginLeft: 2,
            }}
          >
            · {board.activeCount}
          </span>
        )}
      </button>

      <FloatingPanel
        open={open}
        onClose={() => setOpen(false)}
        title={
          <TaskBoardTitle
            taskSearch={board.taskSearch}
            setTaskSearch={board.setTaskSearch}
          />
        }
        defaultSize={{ width: 720, height: 620 }}
        minSize={{ width: 460, height: 380 }}
        storageKey="lattice.taskboard.window"
      >
        <TaskBoardPanelBody board={board} />
      </FloatingPanel>
    </>
  );
}
