import fs from 'node:fs/promises';
import { seedClaudeTrust } from '../claudeTrust.js';
import { instructionsFilePath } from './commands.js';
import { renderPostMergeHookInstructions } from './instructions.js';
import {
  assertSafePostMergeHookPath,
  createPostMergeHookId,
} from './paths.js';
import {
  installPostMergeHookStopHook,
  postMergeHookCallbackUrl,
} from './stopHook.js';
import type { PostMergeHookSession } from './types.js';

// Materialize the scratch dir: write the brief and install the harness's
// Stop-hook / extension plumbing. Mirrors pushRuns/session.ts:setupPushSession.
//
// This is the filesystem + trust-seeding half of a post-merge hook: it owns
// the throwaway scratch dir, seeds Claude's workspace trust so the first
// launch doesn't stall, installs the completion plumbing, and renders the
// instruction brief. The trigger/outcome half (deciding whether to run,
// recording the run, spawning the pty) lives in `trigger.ts`.
export async function setupPostMergeHookSession(args: {
  projectPath: string;
  backendOrigin: string;
  prompt: string;
  harness: PostMergeHookSession['harness'];
}): Promise<PostMergeHookSession> {
  const { projectPath, backendOrigin, prompt, harness } = args;
  const id = createPostMergeHookId();
  const cwd = assertSafePostMergeHookPath(projectPath, id);
  await fs.mkdir(cwd, { recursive: true });

  // Trust the scratch dir for Claude so the very first launch doesn't stall
  // on the workspace-trust dialog. Project-root trust isn't our concern here.
  await seedClaudeTrust(cwd);

  await installPostMergeHookStopHook({
    scratchDir: cwd,
    id,
    backendOrigin,
    projectPath,
    harness,
  });

  const callbackUrl = postMergeHookCallbackUrl(id, backendOrigin);
  const instructionsFile = instructionsFilePath(cwd);
  await fs.writeFile(
    instructionsFile,
    renderPostMergeHookInstructions({
      projectPath,
      prompt,
      callbackUrl,
      harness,
    }),
    'utf8',
  );

  return { id, cwd, instructionsFile, harness };
}
