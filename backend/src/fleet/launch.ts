// Fleet "prompt a project": open an agent terminal in any project, already
// working on a request. The request is written to
// `<project>/.lattice/fleet-prompts/<id>.md` and the agent is launched with a
// short pointer to it, so arbitrary prompt text never rides a shell command
// line. Spawned through the normal chokepoint (MCP, system prompt, trust) as a
// `user` tab in that project's sidebar; one launched by an AGENT carries the
// `fleet-agent` scope, which keeps the controller and fleet tools out of it.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { buildAgentCommand } from '../agentCommandBuilder.js';
import { isAgentHarness, type AgentEffort, type AgentHarness } from '../harnesses.js';
import { isRealAbsoluteProjectPath } from '../projectPath.js';
import { PROJECT_DIR_NAME } from '../tasks.js';
import type { proxyCreateSession } from '../terminalProxy.js';
import type { FleetLaunchResult } from './types.js';

export const FLEET_PROMPT_DIR = 'fleet-prompts';
const MAX_PROMPT_CHARS = 100_000;

export class FleetLaunchError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 500 | 503) {
    super(message);
  }
}

export type FleetLaunchInput = {
  project: string;
  harness: AgentHarness;
  prompt: string;
  model?: string;
  effort?: AgentEffort;
  piModel?: string;
  label?: string;
  launchedBy: 'user' | 'agent';
};

export type FleetLaunchDeps = {
  createSession: typeof proxyCreateSession;
  codexYolo: (project: string) => Promise<boolean>;
  now: () => number;
};

const HARNESS_LABEL: Record<AgentHarness, string> = { claude: 'Claude', codex: 'Codex', pi: 'Pi' };

// The request body → a validated input, or a 400 message.
export function parseFleetLaunch(raw: unknown, launchedBy: 'user' | 'agent'): FleetLaunchInput | { error: string } {
  const b = (raw ?? {}) as Record<string, unknown>;
  const project = typeof b.project === 'string' ? b.project.trim() : '';
  if (!project || !isRealAbsoluteProjectPath(project)) return { error: 'project must be an absolute project path' };
  if (!isAgentHarness(b.harness)) return { error: 'harness must be claude, codex or pi' };
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
  if (!prompt) return { error: 'prompt is required' };
  if (prompt.length > MAX_PROMPT_CHARS) return { error: `prompt is longer than ${MAX_PROMPT_CHARS} characters` };
  const opt = (k: string) => (typeof b[k] === 'string' && (b[k] as string).trim() ? (b[k] as string).trim() : undefined);
  return {
    project,
    harness: b.harness,
    prompt,
    ...(opt('model') ? { model: opt('model') } : {}),
    ...(opt('effort') ? { effort: opt('effort') as AgentEffort } : {}),
    ...(opt('piModel') ? { piModel: opt('piModel') } : {}),
    ...(opt('label') ? { label: opt('label')!.slice(0, 80) } : {}),
    launchedBy,
  };
}

export async function launchFleetAgent(input: FleetLaunchInput, deps: FleetLaunchDeps): Promise<FleetLaunchResult> {
  const stat = await fs.stat(input.project).catch(() => null);
  if (!stat?.isDirectory()) throw new FleetLaunchError(`no project folder at ${input.project}`, 404);
  const id = `${new Date(deps.now()).toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const rel = `${PROJECT_DIR_NAME}/${FLEET_PROMPT_DIR}/${id}.md`;
  const file = path.join(input.project, PROJECT_DIR_NAME, FLEET_PROMPT_DIR, `${id}.md`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${input.prompt}\n`, 'utf8');
  const pointer = `Read the request in ${rel} (relative to this folder) and do what it asks.`;
  const command = buildAgentCommand({
    harness: input.harness,
    prompt: pointer,
    piModel: input.piModel,
    model: input.model,
    effort: input.effort,
    codexYolo: await deps.codexYolo(input.project),
  });
  const firstLine = input.prompt.split('\n')[0].trim();
  const label = input.label ?? `${HARNESS_LABEL[input.harness]}: ${firstLine.length > 40 ? `${firstLine.slice(0, 39)}…` : firstLine}`;
  const result = await deps.createSession({
    cwd: input.project,
    projectPath: input.project,
    initialCommand: command,
    ...(input.launchedBy === 'agent' ? { mcpScope: 'fleet-agent' as const } : {}),
    registry: { owner: 'user', label, ...(input.piModel ? { piModel: input.piModel } : {}) },
  });
  if ('error' in result) {
    throw new FleetLaunchError(String(result.error), (result as { code?: string }).code === 'CAP' ? 503 : 500);
  }
  return { id: result.id, ...(result.terminalId ? { terminalId: result.terminalId } : {}), label, promptFile: rel };
}
