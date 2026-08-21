import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Retract the live console mirror for a backend we deliberately killed.
//
// `backend/src/crashLog.ts` mirrors its console ring to
// `~/.lattice/logs/live-backend-<pid>.log` and deletes it from an `exit`
// handler. That covers every exit the process is alive to observe — but on
// Windows `child.kill()` is `TerminateProcess`, which runs NO JavaScript in the
// child. A routine dev restart therefore looks exactly like a hard native fault
// from the inside, and the next boot promoted every single one into a
// "died without running any JavaScript" crash file. Thirteen of them inside
// three minutes on the first run, which is precisely the noise that makes a
// crash-log directory worthless when a real crash finally lands in it.
//
// The supervisor is the one party that knows the kill was intentional, so it
// retracts the mirror on its own behalf. Only a death we did NOT ask for — a
// hard fault — is allowed to leave its live file behind for adoption.
export function clearLiveLog(pid, label = 'backend') {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    fs.unlinkSync(path.join(os.homedir(), '.lattice', 'logs', `live-${label}-${pid}.log`));
  } catch {
    /* already gone (the child removed it itself), or no logs dir yet */
  }
}
