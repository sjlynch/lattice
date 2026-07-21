// Resolves the per-project system-prompt override for a harness: the saved
// {append, replace} for that harness, trimmed to only its non-empty sides.
// The spawn chokepoint (terminalServerClient/createSession.ts) calls this and
// turns the result into per-harness injection (a file + CLI flag, a `-c`
// override, or a Pi extension). Returns `null` when nothing is configured.

import { getUserSettings } from '../userSettings.js';
import type {
  HarnessSystemPromptKind,
  HarnessSystemPromptOverride,
} from './defs.js';

export async function resolveHarnessSystemPrompt(
  projectPath: string,
  harness: HarnessSystemPromptKind,
): Promise<HarnessSystemPromptOverride | null> {
  try {
    const settings = await getUserSettings(projectPath);
    const entry = settings.harnessSystemPrompts?.[harness];
    if (!entry) return null;
    // Only honor non-empty sides — a blank field means "leave the built-in
    // prompt alone on that side" (and a blank replace must never blank out the
    // whole system prompt).
    const append =
      typeof entry.append === 'string' && entry.append.trim().length > 0
        ? entry.append
        : undefined;
    const replace =
      typeof entry.replace === 'string' && entry.replace.trim().length > 0
        ? entry.replace
        : undefined;
    if (!append && !replace) return null;
    return { append, replace };
  } catch {
    return null;
  }
}
