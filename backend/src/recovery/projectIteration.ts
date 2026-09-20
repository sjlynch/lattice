import { listKnownProjects } from '../tasks.js';
import { forEachWithConcurrency } from './concurrency.js';

/**
 * Iterate every project known to Lattice, logging list/handler failures
 * without aborting startup recovery for the remaining projects.
 */
export async function forEachKnownProjectSafely(
  label: string,
  handleProject: (repoRoot: string) => Promise<void>,
): Promise<void> {
  let projects: string[];
  try {
    projects = await listKnownProjects();
  } catch (err) {
    console.error(`[startup] ${label}: could not list projects:`, err);
    return;
  }

  // Projects are independent (their only shared state is the console), so
  // walk them with bounded fan-out instead of strictly one at a time: each
  // handler is typically a task-list read plus a git spawn, and 20 known
  // projects serialized added seconds to boot before the port opened.
  await forEachWithConcurrency(projects, PROJECT_CONCURRENCY, async (repoRoot) => {
    try {
      await handleProject(repoRoot);
    } catch (err) {
      console.error(`[startup] ${label}: ${repoRoot} failed:`, err);
    }
  });
}

const PROJECT_CONCURRENCY = 8;
