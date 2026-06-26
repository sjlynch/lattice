import {
  DisallowedProjectGitError,
  hasFlag,
  LATTICE_BRANCH_RE,
} from '../policy.js';

// Expand combined short-flag groups so `-fd` becomes `-f`, `-d`. git lets
// short flags be bundled, so a force-delete can arrive as `-fd`/`-Df` just as
// validly as a bare `-D`; the flag checks below must see those for what they
// are. Long options (`--delete`) and positional operands pass through
// untouched — `--delete` starts with `--`, which the single-dash pattern
// deliberately doesn't match.
function expandShortFlagGroups(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (/^-[A-Za-z]+$/.test(arg)) {
      for (const ch of arg.slice(1)) out.push(`-${ch}`);
    } else {
      out.push(arg);
    }
  }
  return out;
}

function hasLongOption(flags: readonly string[], name: string): boolean {
  // Matches `--name` and `--name=<value>`.
  return flags.some((f) => f === `--${name}` || f.startsWith(`--${name}=`));
}

// Every positional operand on a branch op that can clobber a ref must be a
// `lattice/*` branch — not just the last one. `git branch -D main lattice/x`
// deletes BOTH main and lattice/x, so validating only the final operand is a
// hole the inner-ring guard exists specifically to close.
function assertAllLatticeOperands(operands: string[], action: string): void {
  if (operands.length === 0) {
    throw new DisallowedProjectGitError(`branch ${action} has no target`);
  }
  for (const op of operands) {
    if (!LATTICE_BRANCH_RE.test(op)) {
      throw new DisallowedProjectGitError(
        `branch ${action} target "${op}" is not a lattice/* branch`,
      );
    }
  }
}

export function assertAllowedBranchArgs(rest: string[]): void {
  // Work against expanded short-flag groups so `-fd`/`-Df` are recognised the
  // same as separate `-f -d`. Operands are taken from the raw argv (branch
  // names never start with `-`).
  const flags = expandShortFlagGroups(rest);
  const operands = rest.filter((a) => !a.startsWith('-'));

  // Deletion: only `lattice/*` branches, and EVERY operand must qualify.
  if (
    hasFlag(flags, '-D', '-d') ||
    hasLongOption(flags, 'delete')
  ) {
    assertAllLatticeOperands(operands, 'delete');
    return;
  }
  // Rename / copy could clobber an existing branch (incl. main) — never
  // something Lattice does.
  if (
    hasFlag(flags, '-m', '-M', '-c', '-C') ||
    hasLongOption(flags, 'move') ||
    hasLongOption(flags, 'copy')
  ) {
    throw new DisallowedProjectGitError('branch move/copy is not allowed');
  }
  // Force (`-f`/`--force`) on the *create* form resets an existing ref even if
  // it already exists — `git branch -f main origin/main` would move main. Allow
  // it only when every operand is a `lattice/*` branch.
  if (hasFlag(flags, '-f') || hasLongOption(flags, 'force')) {
    assertAllLatticeOperands(operands, 'force-create');
    return;
  }
  // Otherwise it's a list (`branch`, `branch --list`, `branch -a`, …) or
  // a create (`branch <name> [<start>]`). Both are harmless w.r.t. `.git`.
}
