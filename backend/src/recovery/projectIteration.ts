import { listKnownProjects } from '../tasks.js';

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

  for (const repoRoot of projects) {
    try {
      await handleProject(repoRoot);
    } catch (err) {
      console.error(`[startup] ${label}: ${repoRoot} failed:`, err);
    }
  }
}
