import fs from 'node:fs/promises';
import { canonicalProjectPath } from '../projectPath.js';
import { LATTICE_HOME, PROJECTS_INDEX } from './paths.js';
import { shouldPruneProjectEntry } from './pruneIndex.js';

export class ProjectsIndex {
  private readonly knownProjects = new Set<string>();
  private knownLoaded = false;
  private knownLoadPromise: Promise<void> | null = null;

  public get projects(): Set<string> {
    return this.knownProjects;
  }

  public has(projectPath: string): boolean {
    return this.knownProjects.has(projectPath);
  }

  public add(projectPath: string): void {
    this.knownProjects.add(projectPath);
  }

  public values(): IterableIterator<string> {
    return this.knownProjects.values();
  }

  public list(): string[] {
    return Array.from(this.knownProjects);
  }

  public async loadKnownProjects(): Promise<void> {
    if (this.knownLoaded) return;
    // Single-flight: a concurrent caller awaits the same in-flight load
    // rather than flipping `knownLoaded` true and falling through while the
    // index is still being read. `knownLoaded` flips only once the read has
    // actually populated `knownProjects` (in the `finally` of performLoad).
    if (!this.knownLoadPromise) {
      this.knownLoadPromise = this.performLoadKnownProjects();
    }
    return this.knownLoadPromise;
  }

  private async performLoadKnownProjects(): Promise<void> {
    try {
      let raw: string;
      try {
        raw = await fs.readFile(PROJECTS_INDEX, 'utf8');
      } catch {
        return; // no index yet
      }
      let list: unknown;
      try {
        list = JSON.parse(raw);
      } catch {
        return; // corrupt — leave the file alone, start fresh in memory
      }
      if (!Array.isArray(list)) return;

      // Canonicalize + de-dup every entry. If two entries collapse to the same
      // canonical form (e.g. `f:\rust_etl` and `F:\rust_etl` on Windows), the
      // duplicate is dropped. Both pointed at the same on-disk tasks.json anyway,
      // so there's nothing to merge — we're just deduping the index.
      let dirty = false;
      const candidates: string[] = [];
      const seen = new Set<string>();
      for (const p of list) {
        if (typeof p !== 'string' || !p) {
          dirty = true;
          continue;
        }
        const canonical = canonicalProjectPath(p);
        if (canonical !== p) dirty = true;
        if (seen.has(canonical)) {
          dirty = true;
          continue;
        }
        seen.add(canonical);
        candidates.push(canonical);
      }

      // Prune accumulated junk (temp-dir scratch, mangled paths, phantom entries
      // that a mangled request resolved to). Conservative — a real project is
      // never dropped: anything that exists on disk, or still has task data, is
      // kept. See pruneIndex.ts. Runs at boot so a restart self-cleans the index
      // and it can't grow without bound.
      const pruneFlags = await Promise.all(
        candidates.map((c) => shouldPruneProjectEntry(c)),
      );
      let pruned = 0;
      for (let i = 0; i < candidates.length; i++) {
        if (pruneFlags[i]) {
          pruned += 1;
          dirty = true;
          continue;
        }
        this.knownProjects.add(candidates[i]);
      }

      if (dirty) {
        await this.persistKnownProjects().catch(() => {});
      }
      if (pruned > 0) {
        console.log(
          `[tasks] pruned ${pruned} stale project ` +
            `entr${pruned === 1 ? 'y' : 'ies'} from ~/.lattice/projects.json`,
        );
      }
    } finally {
      this.knownLoaded = true;
      this.knownLoadPromise = null;
    }
  }

  public async persistKnownProjects(): Promise<void> {
    try {
      await fs.mkdir(LATTICE_HOME, { recursive: true });
      await fs.writeFile(
        PROJECTS_INDEX,
        JSON.stringify(Array.from(this.knownProjects), null, 2),
        'utf8',
      );
    } catch (e) {
      console.error('[tasks] persistKnownProjects', e);
    }
  }
}
