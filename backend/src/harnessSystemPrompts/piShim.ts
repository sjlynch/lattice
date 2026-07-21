// Pi's system-prompt override mechanism. Pi has no CLI flag Lattice can use to
// deliver a large, multi-line prompt safely across shells (unlike Claude's
// `--system-prompt-file`), and writing the documented `.pi/SYSTEM.md` would
// clobber a user's own committed file at the project root. So — mirroring how
// `piExtension.ts` installs the completion backstop and `piMcp/` installs the
// MCP loader — Lattice drops a uniquely-named `before_agent_start` extension
// plus a JSON sidecar into the session cwd's `.pi/extensions/`. The extension
// reads the sidecar at agent start and appends/replaces the assembled prompt.
//
// This is the ONE Pi mechanism for both Append and Replace: one code path, a
// deterministic order (replace the base, then append), and it degrades to a
// no-op if a Pi build doesn't honor the hook. The generated `.ts` is written
// only when there's an override; when there isn't, any previously-installed
// pair is removed so a reused cwd (e.g. the project root, shared by the sidebar
// `pi` terminal) doesn't keep a stale prompt.

import path from 'node:path';
import fs from 'node:fs/promises';
import type { HarnessSystemPromptOverride } from './defs.js';

export const PI_SYSTEM_PROMPT_EXTENSION_FILENAME = 'lattice-system-prompt.ts';
export const PI_SYSTEM_PROMPT_CONFIG_FILENAME = 'lattice-system-prompt.json';

// The extension source. `configFile` is embedded as an absolute path (like
// lattice-complete.ts embeds its sentinel path) so the extension doesn't depend
// on Pi's process.cwd(). Kept defensive: any read/parse error, or a Pi build
// that ignores the return value, leaves the prompt unchanged.
export function renderPiSystemPromptExtension(configFile: string): string {
  return `// Lattice-managed — do not commit. Overrides this Pi session's system prompt
// from the sidecar JSON Lattice wrote next to this file (Settings → Agent
// prompts → Harness system prompts). Reads {append?, replace?}: replace swaps
// Pi's persona/base prompt, append adds text after it. Best-effort — any error
// leaves Pi's assembled prompt unchanged.
import fs from "node:fs";

const CONFIG_FILE = ${JSON.stringify(configFile)};

export default function (pi) {
  pi.on("before_agent_start", (event) => {
    try {
      const raw = fs.readFileSync(CONFIG_FILE, "utf8");
      const cfg = JSON.parse(raw);
      let prompt =
        event && typeof event.systemPrompt === "string" ? event.systemPrompt : "";
      if (cfg && typeof cfg.replace === "string" && cfg.replace.trim()) {
        prompt = cfg.replace;
      }
      if (cfg && typeof cfg.append === "string" && cfg.append.trim()) {
        prompt = prompt ? prompt + "\\n\\n" + cfg.append : cfg.append;
      }
      return { systemPrompt: prompt };
    } catch {
      // Leave the assembled prompt untouched on any error.
      return undefined;
    }
  });
}
`;
}

function extPaths(dir: string): { extFile: string; configFile: string } {
  const extDir = path.join(dir, '.pi', 'extensions');
  return {
    extFile: path.join(extDir, PI_SYSTEM_PROMPT_EXTENSION_FILENAME),
    configFile: path.join(extDir, PI_SYSTEM_PROMPT_CONFIG_FILENAME),
  };
}

// Write the extension + JSON sidecar so Pi picks up the override on start. Skips
// a write when contents already match, so a reconciliation doesn't dirty
// `git status`. Best-effort — throws are swallowed by the caller.
async function writePiSystemPromptExtension(
  dir: string,
  override: HarnessSystemPromptOverride,
): Promise<void> {
  const { extFile, configFile } = extPaths(dir);
  await fs.mkdir(path.dirname(extFile), { recursive: true });
  const expectedConfig = JSON.stringify(
    { append: override.append ?? '', replace: override.replace ?? '' },
    null,
    2,
  );
  const expectedExt = renderPiSystemPromptExtension(configFile);
  await writeIfChanged(configFile, expectedConfig);
  await writeIfChanged(extFile, expectedExt);
}

async function writeIfChanged(file: string, expected: string): Promise<void> {
  try {
    const existing = await fs.readFile(file, 'utf8');
    if (existing === expected) return;
  } catch {
    /* absent — write it */
  }
  await fs.writeFile(file, expected, 'utf8');
}

// Remove a previously-installed pair (best-effort). Called when the project has
// no Pi override so a reused cwd doesn't keep a stale prompt extension.
async function removePiSystemPromptExtension(dir: string): Promise<void> {
  const { extFile, configFile } = extPaths(dir);
  await fs.rm(extFile, { force: true }).catch(() => {});
  await fs.rm(configFile, { force: true }).catch(() => {});
}

// Reconcile the Pi system-prompt extension in `dir` to `override`: install it
// (write ext + JSON) when there's something to apply, else strip any stale
// install. Never throws.
export async function applyPiSystemPromptForSpawn(
  dir: string,
  override: HarnessSystemPromptOverride | null,
): Promise<void> {
  try {
    if (override && (override.append || override.replace)) {
      await writePiSystemPromptExtension(dir, override);
    } else {
      await removePiSystemPromptExtension(dir);
    }
  } catch (err) {
    console.warn(
      `[harness-system-prompt] pi extension reconcile failed in ${dir}: ${
        (err as Error).message
      }`,
    );
  }
}
