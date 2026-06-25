import fs from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { matchIgnoredSourcePath } from './constants.js';
import { loadProjectAliases, TSCONFIG_RE, type ParsedAlias } from './tsconfig.js';

// tsconfig*.json filenames that the alias loader recognizes. Matches
// `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, etc. — the
// canonical regex is imported from `tsconfig.ts` rather than re-declared so
// the two can't drift.
const TSCONFIG_BASENAME_RE = TSCONFIG_RE;

export class ConfigReloader {
  private gitignoreMatcher: Ignore = ignore();
  private projectAliases: ParsedAlias[] = [];

  constructor(private readonly projectRoot: string) {}

  static async create(projectRoot: string): Promise<ConfigReloader> {
    const reloader = new ConfigReloader(projectRoot);
    await reloader.reload();
    return reloader;
  }

  get aliases(): readonly ParsedAlias[] {
    return this.projectAliases;
  }

  isIgnored(filePath: string, isDirectory = false): boolean {
    return matchIgnoredSourcePath(
      filePath,
      this.projectRoot,
      this.gitignoreMatcher,
      isDirectory,
    );
  }

  async reload(): Promise<void> {
    const [gitignoreMatcher, aliases] = await Promise.all([
      this.loadGitignore(),
      loadProjectAliases(this.projectRoot),
    ]);
    this.gitignoreMatcher = gitignoreMatcher;
    this.projectAliases = aliases;
  }

  async reloadForPath(filePath: string): Promise<boolean> {
    const base = path.basename(filePath);
    if (base === '.gitignore') {
      // Only react to the project-root .gitignore, not nested ones.
      if (path.resolve(filePath) === path.resolve(this.projectRoot, '.gitignore')) {
        this.gitignoreMatcher = await this.loadGitignore();
        return true;
      }
    }

    if (TSCONFIG_BASENAME_RE.test(base)) {
      // Only react to a tsconfig sitting directly in the project root, mirroring
      // the .gitignore root guard above. `loadProjectAliases` always re-walks
      // every tsconfig in the tree, so a root-tsconfig change already refreshes
      // the whole alias map. Firing on *any* nested tsconfig save instead
      // (frontend/tsconfig.app.json, backend/tsconfig.json, or one the watcher
      // sees inside a worktree) over-fires a full-project rescan +
      // proj.watcher.add(root) + cross-file recompute on edits the root never
      // consumes — and reloads aliases from the root regardless of which file
      // changed. Nested edits fall through to normal analysis (return false);
      // their aliases refresh on the next root-tsconfig change or full scan.
      if (path.dirname(path.resolve(filePath)) === path.resolve(this.projectRoot)) {
        this.projectAliases = await loadProjectAliases(this.projectRoot);
        return true;
      }
    }

    return false;
  }

  private async loadGitignore(): Promise<Ignore> {
    const ig = ignore();
    try {
      const content = await fs.readFile(path.join(this.projectRoot, '.gitignore'), 'utf8');
      ig.add(content);
    } catch {
      // No .gitignore — fine, we still have IGNORE_DIR_NAMES in constants.
    }
    return ig;
  }
}
