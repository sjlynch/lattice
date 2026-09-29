// Pruning keeps ONLY `*.yaml` / `*.yml` files that contain a top-level
// `rules:` key and are not `*.test.yaml` fixtures, plus the pack's LICENSE /
// README so the licence text travels with the rules. That drops the test
// sources, CI config, scripts, stats and — per pack `prune` — the folders
// carrying a licence the default pack must not (see versions.ts).

import fs from 'node:fs/promises';
import path from 'node:path';

const KEEP_ROOT_FILES = /^(LICENSE|LICENCE|COPYING|README)(\..*)?$/i;
const RULE_EXT = /\.ya?ml$/i;
const TEST_FIXTURE = /\.test\.ya?ml$/i;

async function looksLikeRuleFile(file: string): Promise<boolean> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return /^rules\s*:/m.test(text);
  } catch {
    return false;
  }
}

// Removes everything that is not a rule file (see the header). Returns the
// number of rule files kept and the `- id:` entries counted across them. Pure
// with respect to the tree it is given — tested on a fixture tree.
export async function prunePackTree(
  root: string,
  prune: readonly string[],
): Promise<{ ruleFiles: number; ruleCount: number }> {
  for (const rel of prune) {
    await fs.rm(path.join(root, ...rel.split('/')), { recursive: true, force: true });
  }
  let ruleFiles = 0;
  let ruleCount = 0;
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    let kept = false;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) {
          await fs.rm(full, { recursive: true, force: true });
          continue;
        }
        const childKept = await walk(full, depth + 1);
        if (!childKept) await fs.rm(full, { recursive: true, force: true });
        kept ||= childKept;
        continue;
      }
      if (depth === 0 && KEEP_ROOT_FILES.test(entry.name)) {
        kept = true;
        continue;
      }
      const isRule =
        entry.isFile() &&
        RULE_EXT.test(entry.name) &&
        !TEST_FIXTURE.test(entry.name) &&
        !entry.name.startsWith('.') &&
        (await looksLikeRuleFile(full));
      if (!isRule) {
        await fs.rm(full, { force: true });
        continue;
      }
      ruleFiles += 1;
      const text = await fs.readFile(full, 'utf8');
      ruleCount += (text.match(/^\s*-\s*id\s*:/gm) ?? []).length;
      kept = true;
    }
    return kept;
  };
  await walk(root, 0);
  return { ruleFiles, ruleCount };
}

// `.tmp-<pack>-…` / `.old-<pack>-…` siblings a crashed or killed install of
// THIS pack left under the rules root. Scoped to the one pack: installs of
// different packs are allowed to overlap (single-flight is per pack), and a
// root-wide sweep deleted a sibling install's in-flight fetch dir — or its
// moved-aside previous tree mid-swap, leaving that pack uninstalled. Only ever
// touches the rules root Lattice owns.
export async function sweepStalePackDirs(root: string, packId: string): Promise<void> {
  // `<prefix><digit>`: the digit after the id keeps `qodana` from matching a
  // `qodana-mit` sibling's dirs.
  const isOwn = (name: string): boolean =>
    [`.tmp-${packId}-`, `.old-${packId}-`].some(
      (prefix) => name.startsWith(prefix) && /^\d/.test(name.slice(prefix.length)),
    );
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isOwn(name)) continue;
    await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
  }
}
