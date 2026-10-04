// Content identities and merging for independent-file scans. Never infer clean
// coverage from a cache hit: coverage comes exclusively from engine output.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { defaultExcludeGlobs } from './scanArgs.js';
import { rulesRootDir } from './paths.js';
import type { ParsedOpengrepOutput } from './parseOutput.js';
import type { OpengrepResolution } from './detect.js';
import { readInfoExclude } from '../scanner/ignore.js';

export type ScanInputs = { configuration: string; files: Record<string, string> };
export type ScanCache = ScanInputs & { reusable: string[] };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const cachePathKey = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;

async function walk(root: string, skip: Set<string>, signal?: AbortSignal, strict = false): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string) {
    signal?.throwIfAborted();
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (strict && entry.isSymbolicLink()) throw new Error('Linked rules require a full scan');
      if (entry.isDirectory() && !skip.has(entry.name)) await visit(abs);
      else if (entry.isFile()) files.push(abs); // Never follow symlinks/reparse points.
    }
  }
  const stat = await fs.lstat(root);
  if (stat.isFile()) return [root];
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsupported scan input');
  await visit(root);
  return files;
}

async function hashes(files: string[], root: string, maxBytes: number, signal?: AbortSignal) {
  const out: Record<string, string> = Object.create(null);
  let cursor = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < files.length) {
      signal?.throwIfAborted();
      const file = files[cursor++];
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) continue;
      const key = path.relative(root, file).replace(/\\/g, '/');
      out[key] = hash(await fs.readFile(file));
    }
  }));
  return out;
}

export async function captureScanInputs(opts: {
  project: string; engine: OpengrepResolution; rulePaths: string[];
  excludeGlobs: string[]; targets: string[]; signal?: AbortSignal;
}): Promise<ScanInputs> {
  const skip = new Set([...defaultExcludeGlobs(), '.git']);
  const inventory = await walk(opts.project, skip, opts.signal);
  const files = await hashes(inventory, opts.project, 1_000_000, opts.signal);
  const rules: Record<string, Record<string, string>> = {};
  for (const rulePath of opts.rulePaths) {
    const abs = path.resolve(rulesRootDir(), rulePath);
    rules[rulePath] = await hashes(await walk(abs, new Set(['.git']), opts.signal, true), abs, Infinity, opts.signal);
  }
  const context: Record<string, string> = {};
  const ignoreFiles = inventory.filter((file) => /^\.(?:git|semgrep|opengrep)ignore$/.test(path.basename(file)));
  for (const file of ignoreFiles) {
    const content = await fs.readFile(file);
    if (/^\s*:include\b/m.test(content.toString())) throw new Error('External ignore files require a full scan');
    context[path.relative(opts.project, file)] = hash(content);
  }
  const dotGit = path.join(opts.project, '.git');
  const gitStat = await fs.lstat(dotGit).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  // Linked/nested worktree configuration belongs outside this input tree.
  // Keep scans available, but do not reuse until those dependencies are tracked.
  if (gitStat && !gitStat.isDirectory()) throw new Error('External git directory requires a full scan');
  if (!gitStat) {
    for (let parent = path.dirname(opts.project); parent !== path.dirname(parent); parent = path.dirname(parent)) {
      if (await fs.lstat(path.join(parent, '.git')).then(() => true, (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return false;
        throw err;
      })) throw new Error('Parent repository configuration requires a full scan');
    }
  }
  if (Object.keys(process.env).some((key) => /^(GIT_(?:CONFIG(?:_(?:GLOBAL|SYSTEM|PARAMETERS))?|DIR|WORK_TREE|INDEX_FILE)|XDG_CONFIG_HOME)$/.test(key)) ||
      Object.entries(process.env).some(([key, value]) => /^GIT_CONFIG_KEY_\d+$/.test(key) && /^(?:include(?:if)?\.|core\.excludesfile$)/i.test(value ?? '')))
    throw new Error('External git environment requires a full scan');
  for (const file of [path.join(dotGit, 'config'), path.join(dotGit, 'config.worktree'), path.join(dotGit, 'index'),
    path.join(os.homedir(), '.gitconfig'), path.join(os.homedir(), '.config', 'git', 'config'),
    path.join(rulesRootDir(), '.gitignore'), path.join(rulesRootDir(), '.semgrepignore'),
    path.join(os.homedir(), '.config', 'git', 'ignore')]) {
    const content = await fs.readFile(file).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return Buffer.from('');
      throw err;
    });
    // External git include/exclude files may change without their referencing
    // config changing. Until those dependencies are tracked, reuse is unsafe.
    if ((file.endsWith('.gitconfig') || /^config(?:\.worktree)?$/.test(path.basename(file))) &&
        /(^\s*\[(?:include|includeIf)\b|^\s*excludesfile\s*=)/im.test(content.toString()))
      throw new Error('External git configuration requires a full scan');
    if (file.endsWith('.semgrepignore') && /^\s*:include\b/m.test(content.toString()))
      throw new Error('External ignore files require a full scan');
    context[file] = hash(content);
  }
  context.infoExclude = hash(await readInfoExclude(opts.project) ?? '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SEMGREP|OPENGREP)_|^GIT_CONFIG_/.test(key)));
  return { files, configuration: hash(JSON.stringify({ schema: 1,
    engine: opts.engine, rules, context, env,
    excludes: opts.excludeGlobs, targets: opts.targets,
    limits: [30, 3, 1_000_000], analysis: 'independent-files',
  }, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)) };
}

export function changedPaths(before: ScanInputs, after: ScanInputs): string[] {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter((file) => before.files[file] !== after.files[file]);
}

export function reusablePaths(parsed: ParsedOpengrepOutput, exitCode: number | null, before: ScanInputs, after: ScanInputs): string[] {
  if (before.configuration !== after.configuration || parsed.skippedRules || exitCode === null || exitCode > 1 ||
      parsed.errors.some((err) => !err.path)) return [];
  const uncertain = new Set([...parsed.partiallyParsed, ...parsed.errors.flatMap((e) => e.path ? [e.path] : [])].map(cachePathKey));
  return Object.keys(after.files).filter((file) => before.files[file] === after.files[file] && !uncertain.has(cachePathKey(file)));
}

export function mergeScanOutput(previous: ParsedOpengrepOutput, next: ParsedOpengrepOutput, reused: Set<string>): ParsedOpengrepOutput {
  const keep = (file: string) => reused.has(cachePathKey(file));
  // Include patterns may select additional files with the same suffix. Replace
  // those too, so the combined report never duplicates an engine finding.
  for (const file of [...next.scannedPaths, ...next.partiallyParsed,
    ...next.findings.map((f) => f.path), ...next.errors.flatMap((e) => e.path ? [e.path] : [])]) reused.delete(cachePathKey(file));
  const scannedPaths = [...previous.scannedPaths.filter(keep), ...next.scannedPaths];
  return { ...next,
    findings: [...previous.findings.filter((f) => keep(f.path)), ...next.findings],
    scannedPaths: [...new Set(scannedPaths)], scannedFiles: new Set(scannedPaths).size,
    partiallyParsed: [...previous.partiallyParsed.filter(keep), ...next.partiallyParsed],
    errors: [...previous.errors.filter((e) => e.path && keep(e.path)), ...next.errors],
  };
}
