#!/usr/bin/env node
//
// Maintainer tool: pin an Opengrep release into backend/src/opengrep/versions.ts.
//
//   node scripts/opengrep-pin.mjs [vX.Y.Z] [--cache-dir <dir>] [--cosign <path>]
//
// For every asset Lattice installs (the names come from the OPENGREP_ASSETS
// block in versions.ts) it downloads the binary plus its Sigstore `.sig` and
// `.cert` from the GitHub release, runs `cosign verify-blob` against the
// Opengrep release-workflow identity (OPENGREP_SIGNING_IDENTITY), and only
// then hashes the bytes and rewrites the pin block. A single failed
// verification — or no working `cosign` at all — aborts with nothing written:
// the whole point of pinning is that end users inherit this signature check
// through the digests, so a silent downgrade to "hash whatever GitHub served"
// would defeat it.
//
// `--cache-dir` reuses previously downloaded files (matched by size) so a
// re-run after a transient failure does not fetch ~350 MB again. Install
// cosign from https://github.com/sigstore/cosign/releases (or `--cosign` to
// point at a local copy).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSIONS_TS = path.join(REPO_ROOT, 'backend', 'src', 'opengrep', 'versions.ts');
const BLOCK_START = '// <opengrep-pin:assets>';
const BLOCK_END = '// </opengrep-pin:assets>';

function fail(msg) {
  console.error(`\n[opengrep-pin] ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { tag: null, cacheDir: null, cosign: 'cosign' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cache-dir') out.cacheDir = argv[++i];
    else if (a === '--cosign') out.cosign = argv[++i];
    else if (a.startsWith('--')) fail(`unknown option ${a}`);
    else out.tag = a;
  }
  return out;
}

function readVersionsTs() {
  const src = fs.readFileSync(VERSIONS_TS, 'utf8');
  const version = /export const OPENGREP_VERSION = '([^']+)'/.exec(src)?.[1];
  const issuer = /oidcIssuer: '([^']+)'/.exec(src)?.[1];
  const identityRegexp = /identityRegexp:\s*\n?\s*'((?:[^'\\]|\\.)+)'/.exec(src)?.[1];
  const start = src.indexOf(BLOCK_START);
  const end = src.indexOf(BLOCK_END);
  if (!version || !issuer || !identityRegexp || start < 0 || end < 0) {
    fail(`could not parse ${VERSIONS_TS} (version / signing identity / pin block)`);
  }
  const block = src.slice(start, end);
  const assets = [...block.matchAll(/^\s*'([^']+)':\s*\{/gm)].map((m) => m[1]);
  if (assets.length === 0) fail('no asset names found in the pin block');
  return {
    src,
    version,
    issuer,
    // The TS source doubles the backslashes; undo that for the regexp value.
    identityRegexp: identityRegexp.replace(/\\\\/g, '\\'),
    assets,
    start,
    end,
  };
}

function ensureCosign(cosign) {
  const r = spawnSync(cosign, ['version'], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) {
    fail(
      `cosign is required and "${cosign} version" did not run ` +
        `(${r.error ? r.error.message : `exit ${r.status}`}). Install it from ` +
        'https://github.com/sigstore/cosign/releases or pass --cosign <path>. ' +
        'Refusing to pin unverified digests.',
    );
  }
  const line = (r.stdout + r.stderr).split('\n').find((l) => /GitVersion|version/i.test(l));
  console.log(`[opengrep-pin] cosign: ${line?.trim() ?? 'ok'}`);
}

async function fetchRelease(tag) {
  const res = await fetch(`https://api.github.com/repos/opengrep/opengrep/releases/tags/${tag}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'lattice-opengrep-pin' },
  });
  if (!res.ok) fail(`GitHub release ${tag} lookup failed: HTTP ${res.status}`);
  const json = await res.json();
  const byName = new Map(json.assets.map((a) => [a.name, a]));
  return { publishedAt: json.published_at, byName };
}

async function download(url, dest, expectedBytes) {
  try {
    const st = await fsp.stat(dest);
    if (expectedBytes == null || st.size === expectedBytes) {
      console.log(`  cached  ${path.basename(dest)}`);
      return;
    }
  } catch {
    /* not cached */
  }
  process.stdout.write(`  fetch   ${path.basename(dest)} … `);
  const res = await fetch(url, { headers: { 'user-agent': 'lattice-opengrep-pin' } });
  if (!res.ok) fail(`download failed: ${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (expectedBytes != null && buf.length !== expectedBytes) {
    fail(`${path.basename(dest)}: got ${buf.length} bytes, release says ${expectedBytes}`);
  }
  await fsp.writeFile(dest, buf);
  console.log(`${buf.length} bytes`);
}

function verifyBlob(cosign, dir, asset, issuer, identityRegexp) {
  const args = [
    'verify-blob',
    '--certificate', path.join(dir, `${asset}.cert`),
    '--signature', path.join(dir, `${asset}.sig`),
    '--certificate-oidc-issuer', issuer,
    '--certificate-identity-regexp', identityRegexp,
    path.join(dir, asset),
  ];
  const r = spawnSync(cosign, args, { encoding: 'utf8', windowsHide: true });
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.error || r.status !== 0 || !/Verified OK/.test(out)) {
    fail(
      `Sigstore verification FAILED for ${asset}:\n${out.trim()}\n` +
        'Nothing was written. Do not pin this release until the signature verifies.',
    );
  }
}

function sha256File(file) {
  const h = createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const current = readVersionsTs();
  const tag = args.tag ?? `v${current.version}`;
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) fail(`tag must look like v1.2.3, got ${tag}`);
  const version = tag.slice(1);
  const cacheDir =
    args.cacheDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrep-pin-')));
  await fsp.mkdir(cacheDir, { recursive: true });

  ensureCosign(args.cosign);
  console.log(`[opengrep-pin] release ${tag}, cache ${cacheDir}`);
  const release = await fetchRelease(tag);
  const base = `https://github.com/opengrep/opengrep/releases/download/${tag}`;

  const pins = {};
  for (const asset of current.assets) {
    const meta = release.byName.get(asset);
    if (!meta) fail(`release ${tag} has no asset named ${asset}`);
    if (!release.byName.get(`${asset}.sig`) || !release.byName.get(`${asset}.cert`)) {
      fail(`release ${tag}: ${asset} has no .sig/.cert — cannot verify, refusing to pin`);
    }
    console.log(`[opengrep-pin] ${asset}`);
    await download(`${base}/${asset}`, path.join(cacheDir, asset), meta.size);
    await download(`${base}/${asset}.sig`, path.join(cacheDir, `${asset}.sig`), null);
    await download(`${base}/${asset}.cert`, path.join(cacheDir, `${asset}.cert`), null);
    verifyBlob(args.cosign, cacheDir, asset, current.issuer, current.identityRegexp);
    const sha256 = sha256File(path.join(cacheDir, asset));
    pins[asset] = { sha256, bytes: meta.size };
    console.log(`  verified sha256=${sha256}`);
  }

  const lines = [
    BLOCK_START,
    `// Generated by scripts/opengrep-pin.mjs for ${tag} (published ${release.publishedAt}) — do not edit by hand.`,
    '// Every digest below was Sigstore-verified with cosign against OPENGREP_SIGNING_IDENTITY when pinned.',
    'export const OPENGREP_ASSETS: Record<OpengrepAssetName, OpengrepAssetPin> = {',
    ...current.assets.map(
      (a) => `  '${a}': { sha256: '${pins[a].sha256}', bytes: ${pins[a].bytes} },`,
    ),
    '};',
    '',
  ];
  let next =
    current.src.slice(0, current.start) + lines.join('\n') + current.src.slice(current.end);
  next = next.replace(
    /export const OPENGREP_VERSION = '[^']+'/,
    `export const OPENGREP_VERSION = '${version}'`,
  );
  await fsp.writeFile(VERSIONS_TS, next, 'utf8');
  console.log(`[opengrep-pin] wrote ${path.relative(REPO_ROOT, VERSIONS_TS)} (${tag}, ${current.assets.length} assets)`);
}

main().catch((err) => fail(err?.stack ?? String(err)));
