import { useState } from 'react';
import { Radar } from 'lucide-react';
import { FloatingPanel } from '../FloatingPanel';
import { FleetPanel } from './FleetPanel';

type Props = {
  activeFolder: string;
  onSelectFolder: (path: string) => void;
};

// Navbar launcher for Fleet: every Lattice project on this machine — what is
// running where, a cross-project activity feed, prompting an agent into any
// project and watching / typing into any terminal. Polls only while open.
export function FleetLauncher({ activeFolder, onSelectFolder }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="fab" onClick={() => setOpen(true)} title="Fleet: every project at once" aria-label="Open Fleet">
        <Radar size={15} />
        <span>Fleet</span>
      </button>
      <FloatingPanel
        open={open}
        onClose={() => setOpen(false)}
        title="Fleet · every project"
        defaultSize={{ width: 1000, height: 640 }}
        minSize={{ width: 560, height: 380 }}
        storageKey="lattice.fleet.window"
      >
        {open && <FleetPanel activeFolder={activeFolder} onSelectFolder={onSelectFolder} />}
      </FloatingPanel>
    </>
  );
}
