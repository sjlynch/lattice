import { applyTemplate } from '../instructionTemplates/apply.js';
import { DEFAULT_PUSH_TEMPLATE } from '../instructionTemplates/defs.js';
import type { AgentHarness } from '../harnesses.js';

export function renderPushInstructions(
  projectPath: string,
  template: string = DEFAULT_PUSH_TEMPLATE,
  completion?: { harness: AgentHarness; callbackUrl: string },
): string {
  const brief = applyTemplate(template, { project_path: projectPath });
  if (!completion || completion.harness === 'claude') return brief;
  // Pi stays interactive after a turn. Explicit completion closes that session;
  // its shutdown extension and Codex's Stop hook are fallback callbacks.
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
  return `${brief}
## Completion

After reporting the push result, run this as your last action to tell Lattice
that the push session is done. It closes this terminal automatically.

\`\`\`
${curl} -s -m 20 --retry 15 --retry-delay 3 --retry-connrefused -X POST "${completion.callbackUrl}"
\`\`\`
`;
}
