// Per-project user settings (sidebar width, harness preferences, terminal defaults).

import { asJson, patchJson, postJson } from './http';
import type {
  HarnessAvailability,
  HarnessSystemPromptEntry,
  InstructionTemplate,
  PiModelsResult,
  PiProbeModel,
  ProjectEnvResponse,
  UserSettings,
} from './types';
import { subscribeWsShared } from './ws';

// The Pi models available for the harness dropdowns: the full
// `pi --list-models` list, the curated "Pi — X" menu, and Pi's current default.
// Machine-global (no project param). Empty lists when `pi` isn't installed.
// A failed request THROWS rather than reading as "no models": both callers
// must tell the two apart — the Settings → Pi menu draft saves its WHOLE list
// (an empty load then Save would drop every curated pattern), and the shared
// dropdown cache keeps its prior menu on failure instead of blanking every
// "Pi — X" row until the next settings save.
export async function getPiModels(): Promise<PiModelsResult> {
  return asJson<PiModelsResult>(await fetch('/api/pi-models'));
}

// "Detect models" for the Settings → Pi endpoint form: ask the backend to GET
// <baseUrl>/models on an OpenAI-compatible server and return what it offers —
// each model id plus the context length the server advertised, when it does.
// Throws (via asJson) with the backend's message on a bad URL / unreachable
// endpoint so the form can surface it.
export async function probePiEndpoint(
  baseUrl: string,
  apiKey?: string,
): Promise<PiProbeModel[]> {
  const data = await postJson<{ models: PiProbeModel[] }>(
    '/api/pi-endpoints/probe',
    { baseUrl, apiKey },
  );
  return data.models ?? [];
}

// Live harness-availability subscription. The backend pushes the
// `{claude, pi, codex}` map once `detectHarnesses()` resolves and on
// every reconnect, so the UI picks up the Pi/Codex/Interleave options
// the moment the backend finishes its CLI probe — even when the page
// was loaded before the server was listening.
export function subscribeHarnesses(
  onUpdate: (avail: HarnessAvailability) => void,
): () => void {
  // Shared: the task board, workflow editor, settings and sidebar each mount a
  // consumer, and one socket with a replayed snapshot serves them all.
  return subscribeWsShared<HarnessAvailability>('/ws/harnesses', onUpdate, () => true);
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

// Same GET, but a failure THROWS (an `HttpError` for a non-2xx) instead of
// reading as "this project has no settings". An editor that saves a whole
// sub-object back (Settings → Tools' `opengrep` block) must be able to tell
// the two apart: `{}` from a mid-restart backend, taken as the loaded state,
// would have the next Save wipe every list the project had.
export async function fetchUserSettingsStrict(projectPath: string): Promise<UserSettings> {
  return asJson<UserSettings>(await fetch(`/api/settings?project=${encodeURIComponent(projectPath)}`));
}

export async function patchUserSettings(
  projectPath: string,
  partial: Partial<UserSettings>,
): Promise<UserSettings> {
  return patchJson<UserSettings>(
    `/api/settings?project=${encodeURIComponent(projectPath)}`,
    partial,
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
    await postJson('/api/project-instrumentation', { project: projectPath });
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

// Read-only previews of the instruction files Lattice hands to spawned agents
// (task brief, conflict resolver, QA / push / post-merge / workflow briefs),
// rendered with sample values. Backs the settings dialog's "Agent prompts" tab.
export async function fetchInstructionTemplates(
  projectPath: string,
): Promise<InstructionTemplate[]> {
  const data = await asJson<{ templates: InstructionTemplate[] }>(
    await fetch(`/api/instruction-templates?project=${encodeURIComponent(projectPath)}`),
  );
  return data.templates;
}

// Per-harness system-prompt editor data: each harness's read-only default
// overview plus the project's current Append / Replace override text. Backs the
// "Harness system prompts" section of the settings dialog's "Agent prompts" tab.
export async function fetchHarnessSystemPrompts(
  projectPath: string,
): Promise<HarnessSystemPromptEntry[]> {
  const data = await asJson<{ harnesses: HarnessSystemPromptEntry[] }>(
    await fetch(
      `/api/harness-system-prompts?project=${encodeURIComponent(projectPath)}`,
    ),
  );
  return data.harnesses;
}
