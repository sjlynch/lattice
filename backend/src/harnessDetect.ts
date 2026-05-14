// Detects which agent CLIs (`claude`, `pi`, `codex`) are on PATH so the UI
// can hide options that wouldn't actually run. Probed once lazily and
// cached — the set of installed CLIs doesn't change during a server session.

import { spawn } from 'node:child_process';
import { ALL_AGENT_HARNESSES, type AgentHarness } from './harnesses.js';

export type HarnessAvailability = Record<AgentHarness, boolean>;

let cached: Promise<HarnessAvailability> | null = null;

function isOnPath(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let child;
    try {
      child = spawn(probe, [cmd], { shell: false, windowsHide: true });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      try { child!.kill(); } catch { /* already exited */ }
      finish(false);
    }, 2000);
    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

export function detectHarnesses(): Promise<HarnessAvailability> {
  if (!cached) {
    cached = Promise.all(ALL_AGENT_HARNESSES.map((harness) => isOnPath(harness)))
      .then((available) => ({
        claude: available[0] ?? false,
        pi: available[1] ?? false,
        codex: available[2] ?? false,
      }));
  }
  return cached;
}

// Force a re-probe — useful if the user installs a CLI after the server is
// already running and wants the UI to pick it up without a full restart.
export function resetHarnessCache(): void {
  cached = null;
}
