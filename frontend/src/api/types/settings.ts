import type { HarnessAvailability } from '../../harnesses';
import type {
  OpengrepProjectSettings,
  OpengrepSeverity,
  TerminalDefaultHarness,
  UserSettings,
} from '../../../../backend/src/shared/wireTypes';

// The backend's own per-project settings types (backend/src/userSettings/types.ts,
// re-exported through backend/src/shared/wireTypes.ts). Add a field THERE.
export type {
  RecentSpecGap,
  StartupTerminal,
  TerminalDefaultHarness,
  UserSettings,
} from '../../../../backend/src/shared/wireTypes';

export type TerminalLaunchSettings = {
  terminalDefaultHarness: TerminalDefaultHarness;
  terminalClaudeSkipPermissions: boolean;
  // Whether Codex launches with `--yolo` (its analogue of Claude's
  // `--dangerously-skip-permissions`). Drives the sidebar's new-Codex-terminal
  // default; also read by the backend for every Codex agent spawn. Default ON.
  codexYolo: boolean;
};

// The backend's own Opengrep settings types (backend/src/opengrep/types.ts,
// re-exported through backend/src/shared/wireTypes.ts).
export type { OpengrepProjectSettings, OpengrepSeverity };

// Extensions Lattice ignores by default in the LOC and code-health overlays.
// Config/data and prose files are often long but not meaningful code-health
// signal, so their line counts and fallback "smell" scores stay out of the
// metric overlays unless a project explicitly opts them back in.
export const DEFAULT_METRICS_IGNORED_EXTS: readonly string[] = [
  // Structured config / data — no real complexity signal, scored only by the
  // regex fallback analyzer, so their LOC + "smell" numbers are just noise.
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.csv',
  // Prose / docs.
  '.md',
  '.mdx',
  '.txt',
];

export function isTerminalDefaultHarness(
  value: unknown,
): value is TerminalDefaultHarness {
  return (
    value === 'claude' ||
    value === 'pi' ||
    value === 'codex' ||
    value === 'terminal'
  );
}

export function normalizeTerminalLaunchSettings(
  settings: Pick<
    UserSettings,
    'terminalDefaultHarness' | 'terminalClaudeSkipPermissions' | 'codexYolo'
  > | null | undefined,
): TerminalLaunchSettings {
  const defaultHarness = settings?.terminalDefaultHarness;
  return {
    terminalDefaultHarness: isTerminalDefaultHarness(defaultHarness)
      ? defaultHarness
      : 'claude',
    terminalClaudeSkipPermissions:
      typeof settings?.terminalClaudeSkipPermissions === 'boolean'
        ? settings.terminalClaudeSkipPermissions
        : true,
    // Default ON — only an explicit `false` disables `--yolo`.
    codexYolo: settings?.codexYolo !== false,
  };
}

// Coerce a raw extension entry to its canonical form (lowercased, single
// leading dot). Returns null for empties so callers can drop them.
export function normalizeIgnoredExt(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

// Resolves the saved value to the list that should actually be applied:
// `undefined` → the built-in default; everything else → normalized + deduped.
export function effectiveMetricsIgnoredExts(
  saved: string[] | undefined,
): string[] {
  if (saved === undefined) return [...DEFAULT_METRICS_IGNORED_EXTS];
  const seen = new Set<string>();
  for (const raw of saved) {
    const ext = normalizeIgnoredExt(raw);
    if (ext) seen.add(ext);
  }
  return [...seen];
}

export type { HarnessAvailability };

// --- Pi model discovery (GET /api/pi-models): the backend's own types
// (backend/src/piModels/types.ts, re-exported through
// backend/src/shared/wireTypes.ts). `PiMenuEntry.label` excludes the "Pi — "
// prefix; `PiModelInfo.pattern` is the `pi --model` value. ---

export type {
  PiMenuEntry,
  PiModelInfo,
  PiModelsResult,
} from '../../../../backend/src/shared/wireTypes';

// GET /api/codex-models: the models Codex lists in its own picker.
export type { CodexModelInfo } from '../../../../backend/src/shared/wireTypes';

// One model reported by an endpoint probe (POST /api/pi-endpoints/probe).
// `contextWindow` is present only when the server advertised one (vLLM's
// `max_model_len`, llama.cpp's `context_length`, …); it is carried onto the
// saved provider model so models.json gets the server's real window rather
// than Pi's conservative default. See backend piModels/probe.ts.
export type PiProbeModel = { id: string; contextWindow?: number };
