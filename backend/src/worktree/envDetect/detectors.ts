import path from 'node:path';

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

type ManagerResolution = {
  manager: string;
  installCmd: string;
};

export type Detector = {
  id: EnvKind;
  label: string;
  /** Any one of these files at the repo root marks this env as in use. */
  markerFiles: string[];
  /** Any one of these extensions on a file at the repo root marks this env as in use. */
  markerExtensions?: readonly string[];
  /** Any one of these dirs at the repo root counts as "deps installed". */
  heavyDirCandidates: string[];
  /** Resolve the package manager + a fast install command for it. */
  resolveManager: (
    repoRoot: string,
    present: Set<string>,
  ) => Promise<ManagerResolution> | ManagerResolution;
};

// `.NET` projects are identified by file extension at the repo root.
export const DOTNET_MARKER_EXTENSIONS = ['.sln', '.csproj', '.fsproj', '.vbproj'];

// Files at the repo root that influence package-manager detection — used to
// pick the manager flavour (lockfiles) without re-statting per detector.
export const LOCKFILE_NAMES = [
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

export const DETECTORS: Detector[] = [
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
    // Project/solution files use extensions, not fixed names.
    markerFiles: [],
    markerExtensions: DOTNET_MARKER_EXTENSIONS,
    heavyDirCandidates: ['bin', 'obj'],
    resolveManager: () => ({ manager: '.NET', installCmd: 'dotnet restore' }),
  },
];

function hasRootFileWithExtension(
  rootEntries: string[],
  extensions: readonly string[],
): boolean {
  return rootEntries.some((name) =>
    extensions.includes(path.extname(name).toLowerCase()),
  );
}

export function hasDetectorMarker(
  detector: Detector,
  rootEntries: string[],
  rootSet: Set<string>,
): boolean {
  return (
    detector.markerFiles.some((marker) => rootSet.has(marker)) ||
    (detector.markerExtensions
      ? hasRootFileWithExtension(rootEntries, detector.markerExtensions)
      : false)
  );
}
