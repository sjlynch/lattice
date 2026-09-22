import {
  HealthCache,
  compileEntryGlobs,
  detectRoots,
  readPackageJsonRoots,
  type HealthMetrics,
} from '../health/index.js';
import { loadProjectAliases } from '../health/tsconfig.js';
import { beginWatcherScan } from '../health/watcher.js';
import { getUserSettings } from '../userSettings.js';
import { canonicalProjectPath } from '../projectPath.js';
import { loadGitignore } from './ignore.js';
import { collectSourceTree } from './collectSourceTree.js';
import { computeFileMetrics, ScanCancelledError } from './fileMetrics.js';
import { computeCoupling } from './coupling.js';
import { aggregate, type ScanResult } from './graphAggregate.js';

export type ScanOptions = {
  // Cooperative cancellation: when true, the per-file analysis loop
  // throws ScanCancelledError on its next yield. The /api/scan route
  // wires this to response disconnects so a browser refresh mid-scan stops
  // wasting CPU on a response no one will read.
  isCancelled?: () => boolean;
};

export async function scan(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const absRoot = canonicalProjectPath(root);
  const publication = beginWatcherScan(absRoot, options.isCancelled);
  try {
    return await scanProject(absRoot, options, publication);
  } finally {
    publication.finish();
  }
}

async function scanProject(
  absRoot: string,
  options: ScanOptions,
  publication: ReturnType<typeof beginWatcherScan>,
): Promise<ScanResult> {
  const checkCancelled = () => { if (options.isCancelled?.()) throw new ScanCancelledError(); };
  checkCancelled();
  const ig = await loadGitignore(absRoot);
  checkCancelled();
  const collected = await collectSourceTree(absRoot, ig, checkCancelled);
  checkCancelled();

  const cache = new HealthCache(absRoot);
  await publication.loadCache(cache);
  checkCancelled();

  const metrics = await computeFileMetrics(collected.files, {
    cache,
    isCancelled: options.isCancelled,
  });
  const aliases = await loadProjectAliases(absRoot);
  checkCancelled();

  // Entry-point roots for the dead-code / reachability pass: conventional
  // filenames + user-configured globs + package.json entry targets. Anything
  // not reachable from a root is flagged for the `D` overlay.
  const presentFiles = new Set(metrics.map((m) => m.filePath));
  const entryGlobs = (await getUserSettings(absRoot)).deadCodeEntryGlobs ?? [];
  const entryRegexps = compileEntryGlobs(entryGlobs);
  const packageRoots = await readPackageJsonRoots(absRoot, presentFiles);
  checkCancelled();
  const roots = detectRoots(presentFiles, {
    projectRoot: absRoot,
    entryRegexps,
    extraRoots: packageRoots,
  });

  const coupling = computeCoupling(metrics, aliases, roots);

  // Surface a resolver-health warning once per scan. A tripped guard means an
  // implausible share of analyzable files looked dead — usually a module-
  // resolution gap for this project's import style, not real dead code.
  const dcs = coupling.deadCodeStats;
  if (dcs?.downgraded) {
    console.warn(
      `[dead-code] ${dcs.dead}/${dcs.resolvable} analyzable files unreachable ` +
        `(${Math.round((dcs.dead / dcs.resolvable) * 100)}%) — downgraded to ` +
        `"uncertain" rather than flagging. Likely an unresolved import style; ` +
        `check tsconfig paths / entry globs for ${absRoot}.`,
    );
  }
  const result = aggregate(metrics, coupling, {
    root: absRoot,
    directories: collected.directories,
  });

  const seenFiles = new Set(collected.files);
  cache.prune(seenFiles);

  // Publish only if the watcher and its revision still match the scan's
  // starting point. Disk persistence remains asynchronous; an intervening
  // event/newer scan fences both the watcher maps and the old cache snapshot.
  const importsByPath = new Map<string, string[]>();
  const metricsByPath = new Map<string, HealthMetrics>();
  for (const metric of metrics) {
    if (!metric.healthDetails) continue;
    importsByPath.set(metric.filePath, metric.imports);
    metricsByPath.set(metric.filePath, metric.healthDetails);
  }
  await publication.commit(cache, importsByPath, metricsByPath, { packageRoots, entryGlobs });
  checkCancelled();

  return result;
}
