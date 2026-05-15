import fs from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { matchIgnoredSourcePath } from './constants.js';
import { loadProjectAliases, type ParsedAlias } from './tsconfig.js';

// tsconfig*.json filenames that the alias loader recognizes. Matches
// `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, etc. — kept in
// sync with the regex in `tsconfig.ts`.
const TSCONFIG_BASENAME_RE = /^tsconfig(?:\..+)?\.json$/;

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
      this.projectAliases = await loadProjectAliases(this.projectRoot);
      return true;
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
