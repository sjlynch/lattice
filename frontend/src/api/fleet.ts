// Fleet: every project on this machine at once — the cross-project snapshot +
// activity feed, "prompt a project" agent launches, and the screen / input of
// any project's terminal. Backend: backend/src/fleet.ts, routes/fleet.ts.

import { asJson, postJson } from './http';
import type { FleetLaunchResult, FleetSnapshot, TerminalScreen } from './types';

export async function fetchFleet(since = 0): Promise<FleetSnapshot> {
  return asJson<FleetSnapshot>(await fetch(`/api/fleet${since > 0 ? `?since=${since}` : ''}`));
}

export type FleetLaunchRequest = {
  project: string;
  harness: 'claude' | 'codex' | 'pi';
  prompt: string;
  model?: string;
  effort?: string;
  piModel?: string;
  label?: string;
};

export function launchFleetAgent(req: FleetLaunchRequest): Promise<FleetLaunchResult> {
  return postJson<FleetLaunchResult>('/api/fleet/agents', req);
}

export async function fetchTerminalScreen(id: string, lines = 400): Promise<TerminalScreen> {
  return asJson<TerminalScreen>(await fetch(`/api/terminals/${encodeURIComponent(id)}/screen?lines=${lines}`));
}

export function sendTerminalText(id: string, text: string, submit: boolean): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/api/terminals/${encodeURIComponent(id)}/input`, { text, submit });
}
