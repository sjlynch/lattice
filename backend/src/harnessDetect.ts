// Detects which agent CLIs (`claude`, `pi`) are on PATH so the UI can hide
// options that wouldn't actually run. Probed once lazily and cached — the
// set of installed CLIs doesn't change during a server session.

import { spawn } from 'node:child_process';

export type HarnessAvailability = {
  claude: boolean;
  pi: boolean;
};

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
    cached = Promise.all([isOnPath('claude'), isOnPath('pi')]).then(
      ([claude, pi]) => ({ claude, pi }),
    );
  }
  return cached;
}

// Force a re-probe — useful if the user installs `pi` after the server is
// already running and wants the UI to pick it up without a full restart.
export function resetHarnessCache(): void {
  cached = null;
}
