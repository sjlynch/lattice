// Per-project user settings (sidebar width, harness preferences, terminal defaults).

import { asJson } from './http';
import type {
  HarnessAvailability,
  ProjectEnvResponse,
  UserSettings,
} from './types';
import { subscribeWs } from './ws';

// Live harness-availability subscription. The backend pushes the
// `{claude, pi, codex}` map once `detectHarnesses()` resolves and on
// every reconnect, so the UI picks up the Pi/Codex/Interleave options
// the moment the backend finishes its CLI probe — even when the page
// was loaded before the server was listening.
export function subscribeHarnesses(
  onUpdate: (avail: HarnessAvailability) => void,
): () => void {
  return subscribeWs<HarnessAvailability>('/ws/harnesses', onUpdate);
}

export async function fetchUserSettings(projectPath: string): Promise<UserSettings> {
  try {
    const r = await fetch(`/api/settings?project=${encodeURIComponent(projectPath)}`);
    if (!r.ok) return {};
    return r.json();
  } catch {
    return {};
  }
}

export async function patchUserSettings(
  projectPath: string,
  partial: Partial<UserSettings>,
): Promise<UserSettings> {
  return asJson<UserSettings>(
    await fetch(`/api/settings?project=${encodeURIComponent(projectPath)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    }),
  );
}

// Ensure (or, when the per-project setting is off, remove) Lattice's activity
// hooks in the project's `.claude/settings.local.json`. Fire-and-forget on
// project open and after the toggle changes; the backend reads the saved
// setting to decide install vs. remove. Best-effort — never throws.
export async function ensureProjectInstrumentation(
  projectPath: string,
): Promise<void> {
  try {
    await fetch('/api/project-instrumentation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath }),
    });
  } catch {
    /* best-effort */
  }
}

// Auto-detected package-manager environments for a project, each with the
// default and effective (post-override) "fresh worktree, don't reinstall"
// note. Backs the "Agent instructions" tab in the settings dialog.
export async function fetchProjectEnv(projectPath: string): Promise<ProjectEnvResponse> {
  try {
    const r = await fetch(`/api/project-env?project=${encodeURIComponent(projectPath)}`);
    if (!r.ok) return { environments: [] };
    return r.json();
  } catch {
    return { environments: [] };
  }
}
