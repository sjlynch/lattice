import type { DeadCodeStatus, HealthMetrics } from './types.js';
import type { ParsedAlias } from './tsconfig.js';
import {
  applyCrossFile,
  compileEntryGlobs,
  computeCrossFile,
  detectRoots,
  type FileImports,
} from './crossFile.js';

// Trailing-edge debounce window for coalescing a burst of file events into a
// single cross-file pass. Long enough to swallow a git checkout / format-all /
// codegen run (which fire many add/change events back-to-back), short enough to
// stay imperceptible for a single save.
const RECOMPUTE_DEBOUNCE_MS = 40;

// Snapshot of cross-file fields per file; used to detect which files were
// affected by a change so the watcher can broadcast updates for them too.
type CrossFileSnapshot = Map<
  string,
  {
    score: number;
    fanIn: number;
    fanOut: number;
    inCycle: boolean;
    deadCode: DeadCodeStatus | undefined;
    smells: HealthMetrics['smells'];
  }
>;

export function snapshotCrossFile(metrics: Map<string, HealthMetrics>): CrossFileSnapshot {
  const out: CrossFileSnapshot = new Map();
  for (const [fp, m] of metrics) {
    out.set(fp, {
      score: m.score,
      fanIn: m.fanIn ?? 0,
      fanOut: m.fanOut ?? 0,
      inCycle: m.inCycle ?? false,
      deadCode: m.deadCode,
      smells: m.smells,
    });
  }
  return out;
}

export class CrossFileAnalyzer {
  // Precompiled `deadCodeEntryGlobs` → RegExp[]. Compiled once here instead of
  // rebuilding a RegExp per glob per file on every pass (the empty-globs case —
  // the common one — early-returns in matchesEntryGlob, so this is free there).
  private readonly entryRegexps: readonly RegExp[];

  // Memoized root set. A file's CONTENT edit never changes any file's root-ness;
  // only an add/remove/rename does. The watcher invalidates this (see
  // invalidateRoots) on exactly those mutations, so a plain `change` reuses the
  // cached set instead of re-scanning every present file's root-ness.
  private cachedRoots: Set<string> | null = null;

  // PART 1 debounce state. chokidar's awaitWriteFinish only debounces a single
  // file's write, not a burst of N distinct files, so a checkout / format-all /
  // codegen run would fire N back-to-back full O(V+E) passes that re-derive the
  // same final state. We coalesce a window of events into one trailing-edge
  // pass, accumulating each add/change originator so it stays force-broadcast.
  private pendingOriginators = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly options: {
      imports: Map<string, string[]>;
      metrics: Map<string, HealthMetrics>;
      getAliases: () => readonly ParsedAlias[];
      broadcastUpdated: (filePath: string, metrics: HealthMetrics) => void;
      // Project root + dead-code root inputs. `entryGlobs` is the user's
      // `deadCodeEntryGlobs` (precompiled to `entryRegexps` below);
      // `packageRoots` are package.json entry targets resolved once at watcher
      // boot. Conventional roots are derived from the present files and memoized
      // (invalidated on add/remove) rather than rescanned every pass.
      projectRoot: string;
      entryGlobs: readonly string[];
      packageRoots: Set<string>;
    },
  ) {
    this.entryRegexps = compileEntryGlobs(options.entryGlobs);
  }

  // Invalidate the memoized root set. The watcher calls this from its add/remove
  // handlers (and on re-seed) — the only events that can change root-ness. The
  // next recompute lazily rebuilds the set from the current file membership.
  invalidateRoots(): void {
    this.cachedRoots = null;
  }

  // Coalesce per-event recomputes into one trailing-edge pass. Every event in
  // the debounce window collapses into a single recompute; each add/change
  // passes its path (so it's still always-broadcast), while removes / config
  // reloads pass null (the end-of-pass diff covers their fallout). Root-cache
  // invalidation happens synchronously in the handler before this is scheduled,
  // so the single pass sees every add/remove from the window.
  scheduleRecompute(originatorPath: string | null): void {
    if (originatorPath) this.pendingOriginators.add(originatorPath);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const originators = this.pendingOriginators;
      this.pendingOriginators = new Set();
      // The handlers swallowed recompute errors via their `.catch()`; this runs
      // detached in a timer, so guard it here too — a throw must not crash the
      // backend (the watcher keeps running and the next event recomputes).
      try {
        this.recomputeAndBroadcast(originators);
      } catch (err) {
        console.error('[health crossFile]', err);
      }
    }, RECOMPUTE_DEBOUNCE_MS);
    // A pending recompute must not keep the process alive at shutdown — the
    // result is re-derived from each file's (mtime,size) on the next scan.
    this.debounceTimer.unref?.();
  }

  // Re-run the full project cross-file pass and broadcast every file whose
  // score / smells / fanIn / fanOut / inCycle / deadCode changed. `originators` are the
  // coalesced add/change files, always broadcast even when their cross-file
  // fields didn't move (their own smells / score may have changed); null skips
  // that step (removes / config reloads rely purely on the diff below). Used
  // both after single-file edits and after tsconfig/.gitignore reloads.
  recomputeAndBroadcast(originators: ReadonlySet<string> | null): void {
    const { imports, metrics, getAliases, broadcastUpdated } = this.options;
    const before = snapshotCrossFile(metrics);
    const fileImports: FileImports[] = [];
    for (const [fp, ims] of imports) {
      fileImports.push({ filePath: fp, imports: ims });
    }

    const presentFiles = new Set(metrics.keys());
    const roots = this.getRoots(presentFiles);
    const cross = computeCrossFile(fileImports, presentFiles, getAliases(), { roots });
    applyCrossFile(metrics, cross);

    // Always broadcast each originator (its smells / score may have changed even
    // when no cross-file fields did). Then walk the diff for everyone else.
    const broadcasted = new Set<string>();
    if (originators) {
      for (const originatorPath of originators) {
        if (broadcasted.has(originatorPath)) continue;
        const m = metrics.get(originatorPath);
        if (m) {
          broadcastUpdated(originatorPath, m);
          broadcasted.add(originatorPath);
        }
      }
    }

    for (const [fp, m] of metrics) {
      if (broadcasted.has(fp)) continue;
      const prev = before.get(fp);
      if (
        !prev ||
        prev.score !== m.score ||
        prev.fanIn !== (m.fanIn ?? 0) ||
        prev.fanOut !== (m.fanOut ?? 0) ||
        prev.inCycle !== (m.inCycle ?? false) ||
        prev.deadCode !== m.deadCode ||
        // applyCrossFile keeps this array on an unchanged normalized file.
        // A cached-smell repair must still reach the UI when the rounded score
        // is unchanged (including tiny files, whose score is always 100).
        prev.smells !== m.smells
      ) {
        broadcastUpdated(fp, m);
      }
    }
  }

  // Memoized root detection. Roots = conventional roots over the present files
  // ⊕ entry-glob matches ⊕ the boot-resolved package.json roots; only the file
  // membership varies, and that's what invalidateRoots tracks.
  private getRoots(presentFiles: Set<string>): Set<string> {
    if (this.cachedRoots) return this.cachedRoots;
    this.cachedRoots = detectRoots(presentFiles, {
      projectRoot: this.options.projectRoot,
      entryRegexps: this.entryRegexps,
      extraRoots: this.options.packageRoots,
    });
    return this.cachedRoots;
  }
}
