import { startTscWatch } from './tscWatch.mjs';
import { describeExitCode } from './exitStatus.mjs';
import { recordExit } from '../../../scripts/orchestrate/devLog.mjs';

export const COMPILER_RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
export const COMPILER_STABLE_MS = 5 * 60 * 1000;

// The compiler owns no application sessions. Its failure must never call the
// application's real-shutdown path or destroy the last working backend/PTYS.
export function createCompilerLifecycle({
  tscBin,
  startWatch = startTscWatch,
  onCompileSucceeded = () => {},
  now = () => Date.now(),
  retryDelays = COMPILER_RETRY_DELAYS_MS,
  stableMs = COMPILER_STABLE_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
  unschedule = (timer) => clearTimeout(timer),
  record = recordExit,
} = {}) {
  let child = null;
  let timer = null;
  let stopped = false;
  let ready = false;
  let failures = 0;
  let polling = false;
  // A deliberate restart (restart() below) is in flight: the old compiler's
  // exit is expected and relaunches at once, without spending a retry.
  let restartRequested = false;

  function scheduleRepair() {
    if (stopped) return;
    if (failures >= retryDelays.length) {
      console.error(
        `[lattice-backend] automatic TypeScript compilation paused after ${failures} retries. ` +
        'The running backend and terminals are retained. Restart npm run dev when ready to retry.',
      );
      return;
    }
    const delay = retryDelays[failures++];
    console.warn(
      `[lattice-backend] retrying TypeScript watcher in ${delay}ms ` +
      `(attempt ${failures}/${retryDelays.length}, source-file polling); keeping the current backend running.`,
    );
    timer = schedule(() => {
      timer = null;
      if (!stopped) launch();
    }, delay);
  }

  function launch() {
    if (stopped || child || timer) return;
    ready = false;
    const startedAt = now();
    let successfulAt = null;
    let finished = false;
    let spawned = false;
    let c;
    const finish = (code, signal, error) => {
      if (finished) return;
      finished = true;
      ready = false;
      if (child === c) child = null;
      const cause = error ? `spawn failed: ${error.message}` : describeExitCode(code, signal);
      const deliberate = restartRequested;
      restartRequested = false;
      const diagnostic = {
        expected: stopped || deliberate,
        detail: `${cause}; pid=${c?.pid ?? 'unspawned'}; node=${process.version}; ` +
          `${process.platform}/${process.arch}; uptimeMs=${now() - startedAt}; sourceFilePolling=${polling}`,
      };
      let recorded = false;
      let diagnosticTimer;
      const writeDiagnostic = () => {
        if (recorded) return;
        recorded = true;
        if (diagnosticTimer) clearTimeout(diagnosticTimer);
        c?.captureTscOutputTail?.();
        record('tsc-watch', code ?? 1, diagnostic);
      };
      // 'exit' can precede the final stdout/stderr chunks. Keep recovery
      // immediate, but record after 'close' drains them; a bounded fallback
      // still captures unterminated tails if a pipe never closes.
      if (c && !error && (c.stdout || c.stderr)) {
        c.once('close', writeDiagnostic);
        diagnosticTimer = setTimeout(writeDiagnostic, 1000);
        diagnosticTimer.unref?.();
      } else writeDiagnostic();
      if (stopped) return;
      if (deliberate) {
        launch();
        return;
      }
      console.error(`[lattice-backend] TypeScript watcher exited (${cause}); the backend remains running.`);
      // A process that settles and immediately crashes is still a crash loop.
      // Only a genuinely sustained healthy interval replenishes the budget.
      if (successfulAt !== null && now() - successfulAt >= stableMs) failures = 0;
      polling = true;
      scheduleRepair();
    };
    try {
      c = startWatch(tscBin, {
        polling,
        onCompileStart: () => {
          if (!finished && !stopped) ready = false;
        },
        onCompileComplete: (result) => {
          if (finished || stopped) return;
          ready = result.successful;
          if (!ready) {
            successfulAt = null;
            return;
          }
          if (successfulAt === null) successfulAt = now();
          onCompileSucceeded();
        },
      });
      child = c;
      c.once('spawn', () => { spawned = true; });
      c.once('exit', (code, signal) => finish(code, signal));
      c.on('error', (error) => {
        if (!spawned) finish(1, null, error);
        else {
          // An operation error (e.g. kill EPERM) does not prove this compiler
          // stopped. Keep tracking it rather than launch a duplicate writer.
          console.error('[lattice-backend] TypeScript watcher operation failed:', error);
        }
      });
    } catch (error) {
      finish(1, null, error);
    }
  }

  function stop(signal = 'SIGTERM') {
    if (stopped) return;
    stopped = true;
    ready = false;
    if (timer) { unschedule(timer); timer = null; }
    try { child?.kill(signal); } catch (error) {
      console.warn('[lattice-backend] could not stop TypeScript watcher:', error);
    }
  }

  // Start a fresh compiler now — after a dependency install, whose new/changed
  // node_modules an already-running `tsc -w` may never re-resolve (it failed
  // "Cannot find module" and noEmitOnError kept the old dist/). Also resumes a
  // compiler paused after exhausting its retries, with a fresh retry budget.
  // The backend restart that follows still goes through the restart policy.
  function restart(reason) {
    if (stopped) return false;
    console.log(`[lattice-backend] restarting the TypeScript watcher — ${reason}`);
    failures = 0;
    if (timer) { unschedule(timer); timer = null; }
    ready = false;
    if (child) {
      restartRequested = true;
      try { child.kill(); } catch (error) {
        restartRequested = false;
        console.warn('[lattice-backend] could not stop TypeScript watcher for restart:', error);
        return false;
      }
      return true;
    }
    launch();
    return true;
  }

  return { start: launch, stop, restart, canRestartBackend: () => ready && !stopped && Boolean(child) };
}
