import type { HealthUpdate, ProjectWatcher } from './types.js';

export function broadcast(proj: ProjectWatcher, update: HealthUpdate): void {
  for (const sub of proj.subscribers) {
    try {
      sub(update);
    } catch {
      /* ignore — don't let one bad subscriber break others */
    }
  }
}
