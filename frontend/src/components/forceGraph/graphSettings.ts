// User-tweakable graph render + physics settings, persisted per project.
// Sliders that drive these live in GraphSettingsPanel.

export type GraphSettings = {
  fileNodeSize: number;
  dirNodeSize: number;
  labelSize: number;
  dagLevelDistance: number;
  chargeStrength: number;
  linkDistance: number;
  velocityDecay: number;
};

// Defaults: file/dir node sizes are 2× the historical baseline (5.5 / 7) so
// the graph reads more clearly out of the box.
export const DEFAULT_SETTINGS: GraphSettings = {
  fileNodeSize: 11,
  dirNodeSize: 14,
  labelSize: 3.0,
  dagLevelDistance: 50,
  chargeStrength: -30,
  linkDistance: 30,
  velocityDecay: 0.4,
};

export function loadSettings(project: string): GraphSettings {
  if (!project) return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(`lattice.graphSettings.${project}`);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<GraphSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
