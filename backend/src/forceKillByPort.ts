import { execSync } from 'node:child_process';

// Pause after taskkill so Windows releases the listener before the next bind.
const PORT_RELEASE_DELAY_MS = 500;

// Find the PID listening on `port` and SIGKILL/taskkill it. Windows-only —
// POSIX rarely needs this and `lsof | xargs kill -9` against the wrong PID
// is a worse failure mode than the original symptom. Best-effort: any
// failure (no listener, parse miss, taskkill rc != 0) is logged and
// swallowed so the calling spawn gets to try.
export async function forceKillByPort(port: number): Promise<void> {
  if (process.platform !== 'win32') return;
  let netstat: string;
  try {
    netstat = execSync('netstat -ano -p tcp', {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (err) {
    console.warn(
      `[lattice-backend] netstat failed during force-kill: ${(err as Error).message}`,
    );
    return;
  }
  const pids = new Set<string>();
  for (const raw of netstat.split('\n')) {
    const line = raw.trim();
    if (!/LISTENING/i.test(line)) continue;
    // "TCP   127.0.0.1:5185   0.0.0.0:0   LISTENING   12345"
    if (!line.includes(`:${port} `) && !line.includes(`:${port}\t`)) continue;
    const pid = line.split(/\s+/).pop();
    if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
  }
  if (pids.size === 0) return;
  for (const pid of pids) {
    try {
      execSync(`taskkill /F /PID ${pid}`, {
        windowsHide: true,
        stdio: 'ignore',
      });
      console.warn(
        `[lattice-backend] force-killed orphan terminal-server pid ${pid} on port ${port}`,
      );
    } catch (err) {
      console.warn(
        `[lattice-backend] taskkill /F /PID ${pid} failed: ${(err as Error).message}`,
      );
    }
  }
  // Brief pause so Windows releases the listener before the next bind.
  await new Promise<void>((r) => setTimeout(r, PORT_RELEASE_DELAY_MS));
}
