// "Prompt a project" (POST /api/fleet/agents): the request body is validated;
// the prompt goes to `<project>/.lattice/fleet-prompts/` and NEVER onto the
// command line (which carries only a fixed pointer); a human launch is a plain
// user tab while an agent launch carries the `fleet-agent` scope (so the new
// agent can't reach lattice-control / the fleet tools); a CAP refusal is 503.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FleetLaunchError, launchFleetAgent, parseFleetLaunch } from '../fleet/launch.js';
import { isUserLaunchedSpawn } from '../mcp/userLaunchedScope.js';

test('parseFleetLaunch validates project, harness and prompt', () => {
  const abs = path.resolve(os.tmpdir(), 'p');
  assert.deepEqual(parseFleetLaunch({ project: 'rel', harness: 'claude', prompt: 'x' }, 'user'), { error: 'project must be an absolute project path' });
  assert.deepEqual(parseFleetLaunch({ project: abs, harness: 'gpt', prompt: 'x' }, 'user'), { error: 'harness must be claude, codex or pi' });
  assert.deepEqual(parseFleetLaunch({ project: abs, harness: 'pi', prompt: '  ' }, 'user'), { error: 'prompt is required' });
  assert.deepEqual(parseFleetLaunch({ project: abs, harness: 'codex', prompt: ' go ', effort: 'low', model: '' }, 'agent'), { project: abs, harness: 'codex', prompt: 'go', effort: 'low', launchedBy: 'agent' });
});

test('launchFleetAgent writes the prompt file and launches a pointer, scoped by who launched', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-launch-'));
  try {
    const sessions: Array<Record<string, unknown>> = [];
    const createSession = (async (opts: Record<string, unknown>) => { sessions.push(opts); return { id: 'pty7', terminalId: 'tab7' }; }) as never;
    const prompt = 'Fix the "quote" & %PATH% bug\nthen report back';
    const r = await launchFleetAgent({ project, harness: 'claude', prompt, launchedBy: 'user' }, { createSession, codexYolo: async () => true, now: () => Date.parse('2026-10-22T20:00:00Z') });
    assert.equal(r.id, 'pty7');
    assert.equal(r.terminalId, 'tab7');
    assert.match(r.label, /^Claude: Fix the "quote"/);
    assert.equal(fs.readFileSync(path.join(project, r.promptFile), 'utf8'), `${prompt}\n`);
    const cmd = String(sessions[0].initialCommand);
    assert.ok(cmd.startsWith('claude --dangerously-skip-permissions '));
    assert.ok(cmd.includes(r.promptFile), 'the command points at the prompt file');
    assert.ok(!cmd.includes('%PATH%') && !cmd.includes('quote'), 'prompt text never rides the command line');
    assert.equal(sessions[0].mcpScope, undefined);
    assert.equal(isUserLaunchedSpawn({ ...sessions[0], cwd: project } as never), true, 'a human launch is a user tab');

    await launchFleetAgent({ project, harness: 'codex', prompt: 'x', launchedBy: 'agent' }, { createSession, codexYolo: async () => false, now: () => 1 });
    assert.equal(sessions[1].mcpScope, 'fleet-agent');
    assert.ok(!String(sessions[1].initialCommand).includes('--yolo'), 'the project codexYolo setting applies');
    assert.equal(isUserLaunchedSpawn({ ...sessions[1], cwd: project } as never), false, 'an agent launch is never user-launched');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('launchFleetAgent: a missing folder is 404, a CAP refusal 503', async () => {
  const missing = path.join(os.tmpdir(), 'fleet-launch-missing-dir');
  const deps = { createSession: (async () => ({ error: 'full', code: 'CAP' })) as never, codexYolo: async () => true, now: () => 1 };
  await assert.rejects(launchFleetAgent({ project: missing, harness: 'pi', prompt: 'x', launchedBy: 'user' }, deps), (e: unknown) => e instanceof FleetLaunchError && e.status === 404);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-launch-'));
  try {
    await assert.rejects(launchFleetAgent({ project, harness: 'pi', prompt: 'x', launchedBy: 'user' }, deps), (e: unknown) => e instanceof FleetLaunchError && e.status === 503);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
