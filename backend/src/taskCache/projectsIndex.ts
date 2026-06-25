import fs from 'node:fs/promises';
import { canonicalProjectPath } from '../projectPath.js';
import { LATTICE_HOME, PROJECTS_INDEX } from './paths.js';

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

      // Canonicalize every entry. If two entries collapse to the same canonical
      // form (e.g. `f:\rust_etl` and `F:\rust_etl` on Windows), the duplicate is
      // dropped. Both pointed at the same on-disk tasks.json anyway, so there's
      // nothing to merge — we're just deduping the index.
      let dirty = false;
      for (const p of list) {
        if (typeof p !== 'string' || !p) {
          dirty = true;
          continue;
        }
        const canonical = canonicalProjectPath(p);
        if (canonical !== p) dirty = true;
        if (this.knownProjects.has(canonical)) {
          dirty = true;
          continue;
        }
        this.knownProjects.add(canonical);
      }
      if (dirty) {
        await this.persistKnownProjects().catch(() => {});
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
