import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OPENGREP_ASSETS, OPENGREP_RULE_PACKS } from '../opengrep/versions.js';

// The licence boundary of the Opengrep integration, enforced: Lattice is MIT,
// the engine is LGPL-2.1 and the broad rule pack is LGPL-2.1 + Commons Clause.
// That stays harmless ONLY because Lattice never redistributes either — they
// are runtime downloads into ~/.lattice/ (see opengrep/CLAUDE.md, "Licence
// boundary"). So: no Opengrep binary, signature, certificate or third-party
// rule file may ever be tracked in this repository. The repo holds URLs,
// pinned versions/commits and digests, nothing else.

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

test('no Opengrep binary / signature / certificate is tracked in the repo', () => {
  const assetNames = Object.keys(OPENGREP_ASSETS);
  const offenders = trackedFiles().filter((f) => {
    const base = f.split('/').pop() ?? f;
    if (assetNames.some((a) => base === a || base === `${a}.sig` || base === `${a}.cert`)) return true;
    if (/^opengrep([-_].*)?\.(exe|sig|cert|tar\.gz|zip)$/i.test(base)) return true;
    if (/^opengrep(-core)?[_-](windows|manylinux|musllinux|osx|linux)/i.test(base)) return true;
    if (/^cosign(-.*)?\.exe$/i.test(base)) return true;
    return false;
  });
  assert.deepEqual(offenders, [], 'third-party binaries must be downloaded at runtime, never committed');
});

test('no third-party rule pack content is tracked in the repo', () => {
  const tracked = trackedFiles();
  // A rule pack checkout lands under ~/.lattice/opengrep/rules/<packId>/ —
  // if any of those ids (or a semgrep-rules-style language tree of yaml
  // rules) shows up in the repo, someone vendored a pack.
  const packDirs = OPENGREP_RULE_PACKS.map((p) => `/${p.id}/`);
  const offenders = tracked.filter((f) => {
    if (!/\.ya?ml$/i.test(f)) return false;
    if (packDirs.some((d) => f.includes(d))) return true;
    // Rule yaml inside the opengrep module itself would be Lattice-authored
    // (allowed, MIT) — only when it lives under a `rules/` folder there. Any
    // other yaml tree named after a semgrep language pack is suspect.
    return /(^|\/)(opengrep-rules|semgrep-rules|opengrep-sast-rules)\//i.test(f);
  });
  assert.deepEqual(offenders, [], 'rule packs are fetched into ~/.lattice at the user\'s click, never committed');
});

test('the pinned packs are referenced by URL + commit only', () => {
  for (const p of OPENGREP_RULE_PACKS) {
    assert.match(p.repo, /^https:\/\//);
    assert.match(p.commit, /^[0-9a-f]{40}$/);
  }
});
