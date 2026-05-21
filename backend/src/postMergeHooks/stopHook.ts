import path from 'node:path';
import fs from 'node:fs/promises';
import { installClaudeStopHook } from '../claudeStopHook.js';
import type { AgentHarness } from '../harnesses.js';

// Pi extension content for the hook scratch dir. Mirrors
// worktree/stopHook.ts:renderPiCompletionExtension, except it points at the
// post-merge-hook callback rather than a task /complete URL. Inlined (vs.
// re-using the worktree helper with a URL swap) so byte changes to the
// extension contract stay co-located with the hook surface.
function renderPostMergeHookPiExtension(callbackUrl: string): string {
  return `// Lattice-managed — do not commit. Reports post-merge-hook completion to
// Lattice when the Pi session exits.
export default function (pi) {
  pi.on("session_shutdown", async (event) => {
    if (event && event.reason && event.reason !== "quit") return;
    try {
      await fetch(${JSON.stringify(callbackUrl)}, { method: "POST" });
    } catch {
      // best-effort, same as the curl-based Stop hook
    }
  });
}
`;
}

export function postMergeHookCallbackUrl(
  id: string,
  backendOrigin: string,
): string {
  return `${backendOrigin}/api/post-merge-hooks/${id}/complete`;
}

// Installs the harness-specific completion plumbing into the hook scratch
// dir. The hook *runs* with cwd=project root, so we cannot write
// `.claude/settings.local.json` next to the project's checkout (would
// clobber the user's own Claude config). Instead we both:
//   1. Write the Stop hook config into the scratch dir.
//   2. Reuse the same scratch dir as Claude's --add-dir / cwd hint in the
//      command (see command builder).
//
// The harness command itself does `cd <scratchDir>` before launching the
// agent, so Claude picks up the scratch `.claude/settings.local.json` while
// the model still operates against the project repo via explicit absolute
// paths in POST_MERGE_HOOK.md.
export async function installPostMergeHookStopHook(args: {
  scratchDir: string;
  id: string;
  backendOrigin: string;
  harness: AgentHarness;
}): Promise<void> {
  const { scratchDir, id, backendOrigin, harness } = args;
  const callbackUrl = postMergeHookCallbackUrl(id, backendOrigin);
  if (harness === 'claude') {
    await installClaudeStopHook(scratchDir, callbackUrl);
    return;
  }
  if (harness === 'pi') {
    const extDir = path.join(scratchDir, '.pi', 'extensions');
    await fs.mkdir(extDir, { recursive: true });
    await fs.writeFile(
      path.join(extDir, 'lattice-complete.ts'),
      renderPostMergeHookPiExtension(callbackUrl),
      'utf8',
    );
    return;
  }
  // Codex: no Stop hook / extension. POST_MERGE_HOOK.md tells the model to
  // curl the callback itself, and Lattice has no other backstop. The user
  // accepts that risk by selecting Codex for the hook harness.
}
