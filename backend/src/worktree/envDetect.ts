// Detects which package-manager / dependency-cache environments a project
// uses, so Lattice can drop a short "you're in a throwaway worktree — the
// deps dir isn't checked out here, don't reinstall unless the task needs
// it" note into the instructions files it writes (LATTICE_TASK.md,
// MERGE_INSTRUCTIONS.md, …). Without that note, the in-worktree agent
// tends to burn reasoning tokens (and wall-clock) deciding whether to run
// `npm install` and usually does, even for tasks that never touch the
// build/test path.
//
// Detection is deliberately conservative and root-only (no recursive
// workspace scan — that'd slow down every `/run`): an environment is
// reported only when (1) one of its marker files exists at the repo root,
// (2) its heavy dir actually exists in the main checkout (so we never nag
// about something the user themselves never installed), and (3) that heavy
// dir isn't tracked by git (so it genuinely won't be in a fresh worktree).
//
// The note text is overridable per environment via UserSettings
// (`worktreeEnvNotes`) — surfaced in the Lattice settings dialog so users
// can discover and tweak (or blank out) what gets injected.

import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from './exec.js';
import { getUserSettings } from '../userSettings.js';

export type EnvKind =
  | 'node'
  | 'python'
  | 'rust'
  | 'ruby'
  | 'php'
  | 'go'
  | 'maven'
  | 'gradle'
  | 'dotnet';

export type DetectedEnv = {
  id: EnvKind;
  label: string;
  /** The heavy, gitignored dir that won't be in a fresh worktree. */
  heavyDir: string;
  /** Human name of the package manager (e.g. "npm", "pnpm", "poetry"). */
  manager: string;
  /** A reasonably fast install/restore command for that manager. */
  installCmd: string;
};

export type EnvNoteInfo = DetectedEnv & {
  /** The built-in note Lattice would inject for this env. */
  defaultNote: string;
  /**
   * What actually gets injected: the user's override if they set one in
   * `UserSettings.worktreeEnvNotes`, else `defaultNote`. An empty string
   * means the user suppressed the note for this env.
   */
  effectiveNote: string;
};

type Detector = {
  id: EnvKind;
  label: string;
  /** Any one of these files at the repo root marks this env as in use. */
  markerFiles: string[];
  /** Any one of these dirs at the repo root counts as "deps installed". */
  heavyDirCandidates: string[];
  /** Resolve the package manager + a fast install command for it. */
  resolveManager: (
    repoRoot: string,
    present: Set<string>,
  ) => Promise<{ manager: string; installCmd: string }> | { manager: string; installCmd: string };
};

const DETECTORS: Detector[] = [
  {
    id: 'node',
    label: 'Node.js',
    markerFiles: ['package.json'],
    heavyDirCandidates: ['node_modules'],
    resolveManager: (_root, present) => {
      if (present.has('bun.lockb') || present.has('bun.lock')) {
        return { manager: 'bun', installCmd: 'bun install' };
      }
      if (present.has('pnpm-lock.yaml')) {
        return { manager: 'pnpm', installCmd: 'pnpm install --prefer-offline' };
      }
      if (present.has('yarn.lock')) {
        return { manager: 'yarn', installCmd: 'yarn install' };
      }
      // package-lock.json (or nothing) → npm
      return {
        manager: 'npm',
        installCmd: 'npm install --prefer-offline --no-audit --no-fund',
      };
    },
  },
  {
    id: 'python',
    label: 'Python',
    markerFiles: [
      'pyproject.toml',
      'requirements.txt',
      'Pipfile',
      'setup.py',
      'setup.cfg',
    ],
    heavyDirCandidates: ['.venv', 'venv', 'env'],
    resolveManager: (_root, present) => {
      if (present.has('uv.lock')) return { manager: 'uv', installCmd: 'uv sync' };
      if (present.has('poetry.lock')) {
        return { manager: 'poetry', installCmd: 'poetry install' };
      }
      if (present.has('Pipfile.lock') || present.has('Pipfile')) {
        return { manager: 'pipenv', installCmd: 'pipenv install' };
      }
      if (present.has('requirements.txt')) {
        return { manager: 'pip', installCmd: 'pip install -r requirements.txt' };
      }
      return { manager: 'pip', installCmd: 'pip install -e .' };
    },
  },
  {
    id: 'rust',
    label: 'Rust',
    markerFiles: ['Cargo.toml'],
    heavyDirCandidates: ['target'],
    resolveManager: () => ({ manager: 'cargo', installCmd: 'cargo build' }),
  },
  {
    id: 'ruby',
    label: 'Ruby',
    markerFiles: ['Gemfile'],
    // Only the locally-vendored case matters for a worktree; a global gem
    // dir is shared and present everywhere. Forward slash on purpose — used
    // verbatim as a git pathspec, and path.join() accepts it for fs ops.
    heavyDirCandidates: ['vendor/bundle'],
    resolveManager: () => ({ manager: 'bundler', installCmd: 'bundle install' }),
  },
  {
    id: 'php',
    label: 'PHP',
    markerFiles: ['composer.json'],
    heavyDirCandidates: ['vendor'],
    resolveManager: () => ({ manager: 'composer', installCmd: 'composer install' }),
  },
  {
    id: 'go',
    label: 'Go',
    markerFiles: ['go.mod'],
    // Go modules use a global cache; a per-project `vendor/` only exists if
    // `go mod vendor` was run — that's the case worth flagging.
    heavyDirCandidates: ['vendor'],
    resolveManager: () => ({ manager: 'go modules', installCmd: 'go mod download' }),
  },
  {
    id: 'maven',
    label: 'Maven',
    markerFiles: ['pom.xml'],
    heavyDirCandidates: ['target'],
    resolveManager: () => ({ manager: 'Maven', installCmd: 'mvn -o install -DskipTests' }),
  },
  {
    id: 'gradle',
    label: 'Gradle',
    markerFiles: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
    heavyDirCandidates: ['build', '.gradle'],
    resolveManager: () => ({ manager: 'Gradle', installCmd: 'gradle --offline build' }),
  },
  {
    id: 'dotnet',
    label: '.NET',
    // Project/solution files use extensions, not fixed names — handled
    // specially below (markerFiles left empty, markerExtensions used).
    markerFiles: [],
    heavyDirCandidates: ['bin', 'obj'],
    resolveManager: () => ({ manager: '.NET', installCmd: 'dotnet restore' }),
  },
];

// `.NET` projects are identified by file extension at the repo root.
const DOTNET_MARKER_EXTENSIONS = ['.sln', '.csproj', '.fsproj', '.vbproj'];

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// True when nothing under `relDir` is tracked by git in `repoRoot` — i.e.
// `git worktree add` won't materialize it (worktrees get tracked files
// only), so the "this dir isn't here" note is accurate. Tolerant: any git
// failure (shouldn't happen — caller already knows it's a repo) is treated
// as "not tracked" since that's overwhelmingly the real-world case.
async function isUntrackedDir(repoRoot: string, relDir: string): Promise<boolean> {
  try {
    const r = await exec(
      'git',
      ['ls-files', '--error-unmatch', '--', relDir],
      repoRoot,
      { timeoutMs: 5_000 },
    );
    return r.code !== 0;
  } catch {
    return true;
  }
}

// Files at the repo root that influence package-manager detection — used to
// pick the manager flavour (lockfiles) without re-statting per detector.
const LOCKFILE_NAMES = [
  'bun.lockb',
  'bun.lock',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'uv.lock',
  'poetry.lock',
  'Pipfile.lock',
  'Pipfile',
  'requirements.txt',
];

export async function detectProjectEnvironments(repoRoot: string): Promise<DetectedEnv[]> {
  let rootEntries: string[] = [];
  try {
    rootEntries = await fs.readdir(repoRoot);
  } catch {
    return [];
  }
  const rootSet = new Set(rootEntries);
  const hasDotnetMarker = rootEntries.some((name) =>
    DOTNET_MARKER_EXTENSIONS.includes(path.extname(name).toLowerCase()),
  );
  const lockfilesPresent = new Set(LOCKFILE_NAMES.filter((n) => rootSet.has(n)));

  const detected: DetectedEnv[] = [];
  for (const det of DETECTORS) {
    const markerPresent =
      det.id === 'dotnet'
        ? hasDotnetMarker
        : det.markerFiles.some((m) => rootSet.has(m));
    if (!markerPresent) continue;

    let heavyDir: string | null = null;
    for (const cand of det.heavyDirCandidates) {
      if (await isDir(path.join(repoRoot, cand))) {
        heavyDir = cand;
        break;
      }
    }
    if (!heavyDir) continue;
    if (!(await isUntrackedDir(repoRoot, heavyDir))) continue;

    const m = await det.resolveManager(repoRoot, lockfilesPresent);
    detected.push({
      id: det.id,
      label: det.label,
      heavyDir,
      manager: m.manager,
      installCmd: m.installCmd,
    });
  }
  return detected;
}

// The built-in note for a detected env. Single paragraph, no internal
// newlines — so it composes cleanly into a markdown blockquote.
export function defaultEnvNote(env: DetectedEnv): string {
  const dir = env.heavyDir.replace(/\\/g, '/');
  return (
    `**Heads up — fresh worktree (${env.label}).** This task runs in a throwaway git ` +
    `worktree. \`${dir}/\` is gitignored, so it is **not** checked out here. Most tasks ` +
    `(editing code, fixing a bug, refactoring) don't need installed dependencies — ` +
    `**skip \`${env.installCmd}\` unless this task specifically requires running the test ` +
    `suite, a build, or a type-check.** Don't spend reasoning deciding whether to install; ` +
    `default to not. If you do need it, run that command once and move on.`
  );
}

// Resolve the per-env notes against a project's saved settings. Returns one
// entry per detected env (including ones the user suppressed — `effectiveNote
// === ''` — so the settings UI can show that state).
export async function describeProjectEnvs(
  repoRoot: string,
  settings: { worktreeEnvNotes?: Record<string, string> } | undefined,
): Promise<EnvNoteInfo[]> {
  const envs = await detectProjectEnvironments(repoRoot);
  const overrides = settings?.worktreeEnvNotes ?? {};
  return envs.map((env) => {
    const defaultNote = defaultEnvNote(env);
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, env.id);
    const effectiveNote = hasOverride ? String(overrides[env.id] ?? '') : defaultNote;
    return { ...env, defaultNote, effectiveNote };
  });
}

// The notes to actually inject into an instructions file written for a
// worktree of `repoRoot`. Loads the project's UserSettings itself so the
// many instruction-writer call sites don't each have to thread it through.
// Resilient: any failure yields an empty list (no note is strictly better
// than a wrong one).
export async function resolveEnvNotesForInstructions(repoRoot: string): Promise<string[]> {
  try {
    const settings = await getUserSettings(repoRoot);
    const described = await describeProjectEnvs(repoRoot, settings);
    return described.map((e) => e.effectiveNote.trim()).filter((s) => s.length > 0);
  } catch (err) {
    console.warn(`[envDetect] resolveEnvNotesForInstructions(${repoRoot}) failed:`, err);
    return [];
  }
}

// Render a list of env notes as a markdown blockquote callout (or '' when
// there are none). Built-in notes are single-paragraph, but a user override
// can contain newlines — every line gets a `> ` prefix so the blockquote
// stays well-formed; a blank `>` line separates consecutive notes.
export function renderEnvNotesBlock(notes: string[]): string {
  const cleaned = notes.map((n) => n.trim()).filter((n) => n.length > 0);
  if (cleaned.length === 0) return '';
  const quoted = cleaned
    .map((note) =>
      note
        .split('\n')
        .map((line) => (line.length > 0 ? `> ${line}` : '>'))
        .join('\n'),
    )
    .join('\n>\n');
  return `${quoted}\n\n`;
}
