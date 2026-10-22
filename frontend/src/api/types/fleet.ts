// Fleet (GET /api/fleet, terminal screen/input/wait, POST /api/fleet/agents):
// the backend's own wire types (backend/src/fleet/types.ts).
export type {
  FleetAgent,
  FleetEvent,
  FleetEventKind,
  FleetHost,
  FleetLaunchResult,
  FleetMachine,
  FleetProject,
  FleetRun,
  FleetSnapshot,
  FleetTask,
  FleetTerminal,
  TerminalScreen,
} from '../../../../backend/src/shared/wireTypes';
