// Per-project persistence for the 3D graph camera. We store the camera's world
// position plus the OrbitControls target it's looking at; `up` is locked to
// (0,1,0) in `sceneSetup`, so position + target fully determine the view
// (orientation *and* distance). Persisted in localStorage keyed by project so a
// page refresh — or a project switch and back — lands on the same vantage point.

import type { ForceGraph3DInstance } from '3d-force-graph';

export type Vec3 = { x: number; y: number; z: number };

export type CameraState = {
  position: Vec3;
  target: Vec3;
};

const KEY_PREFIX = 'lattice.graphCamera.';

function isFiniteVec(v: unknown): v is Vec3 {
  if (!v || typeof v !== 'object') return false;
  const { x, y, z } = v as Record<string, unknown>;
  return (
    typeof x === 'number' &&
    Number.isFinite(x) &&
    typeof y === 'number' &&
    Number.isFinite(y) &&
    typeof z === 'number' &&
    Number.isFinite(z)
  );
}

// Read the last-saved view for a project, or null if there's none / it's
// corrupt. Non-finite values are rejected so a bad blob can never aim the
// camera somewhere it can't recover from.
export function loadCameraState(project: string): CameraState | null {
  if (!project) return null;
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}${project}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CameraState>;
    if (isFiniteVec(parsed.position) && isFiniteVec(parsed.target)) {
      return { position: parsed.position, target: parsed.target };
    }
  } catch {
    /* ignore corrupt JSON / unavailable storage */
  }
  return null;
}

export function saveCameraState(project: string, state: CameraState): void {
  if (!project) return;
  try {
    localStorage.setItem(`${KEY_PREFIX}${project}`, JSON.stringify(state));
  } catch {
    /* ignore quota / unavailable storage */
  }
}

// Snapshot the graph's live camera position + orbit target. Returns null if the
// camera/controls aren't available yet, or hold a non-finite value (a degenerate
// frame mid-teardown), so callers never persist garbage.
export function readCameraState(
  graph: ForceGraph3DInstance,
): CameraState | null {
  const camera = graph.camera();
  const controls = graph.controls() as { target?: Vec3 } | null;
  const target = controls?.target;
  if (!camera || !target) return null;
  const position = {
    x: camera.position.x,
    y: camera.position.y,
    z: camera.position.z,
  };
  const tgt = { x: target.x, y: target.y, z: target.z };
  if (!isFiniteVec(position) || !isFiniteVec(tgt)) return null;
  return { position, target: tgt };
}
