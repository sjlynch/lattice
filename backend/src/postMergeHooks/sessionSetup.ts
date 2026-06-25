import { setupHomeScratchSession } from '../homeScratch/session.js';
import { POST_MERGE_HOOK_FILENAME } from './commands.js';
import { renderPostMergeHookInstructions } from './instructions.js';
import { resolveInstructionTemplate } from '../instructionTemplates.js';
import { postMergeHookPaths } from './paths.js';
import {
  installPostMergeHookStopHook,
  postMergeHookCallbackUrl,
} from './stopHook.js';
import type { PostMergeHookSession } from './types.js';

// Materialize the scratch dir: write the brief and install the harness's
// Stop-hook / extension plumbing. Thin wrapper over the shared
// `setupHomeScratchSession` builder (mirrors pushRuns/qaRuns session setup);
// the harness-specific completion plumbing + brief wording stay here.
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
  const session = await setupHomeScratchSession({
    paths: postMergeHookPaths,
    projectPath,
    instructionsFileName: POST_MERGE_HOOK_FILENAME,
    installHooks: ({ cwd, id }) =>
      installPostMergeHookStopHook({
        scratchDir: cwd,
        id,
        backendOrigin,
        projectPath,
        harness,
      }),
    renderInstructions: async ({ id }) => {
      const callbackUrl = postMergeHookCallbackUrl(id, backendOrigin);
      const template = await resolveInstructionTemplate(
        projectPath,
        'post-merge-hook',
      );
      return renderPostMergeHookInstructions({
        projectPath,
        prompt,
        callbackUrl,
        harness,
        template,
      });
    },
  });

  return { ...session, harness };
}
