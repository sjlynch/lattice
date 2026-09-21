// Managed engine install: download the pinned release asset for this machine
// into `~/.lattice/opengrep/`, verify it, and make it the managed binary.
//
// Verification is the pinned SHA-256 from versions.ts (Sigstore-verified when
// the maintainer pinned it — see scripts/opengrep-pin.mjs). The download is
// streamed into `downloads/` (outside `bin/`) while hashing; the byte count is
// compared to the pin first (a truncated transfer fails with a size message),
// then the digest; only a verified file is renamed into `bin/<version>/`. The
// installed binary is then run once (`--version`) so an antivirus quarantine
// surfaces as a clear message at install time rather than an ENOENT during a
// workflow step.
//
// Single-flight: one install job at a time, exposed as a snapshot for the
// Settings card to poll. Never runs at boot — the user clicks Install.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { probeOpengrepVersion, resetOpengrepCache } from './detect.js';
import { downloadsDir, managedBinaryDir, managedBinaryPath } from './paths.js';
import { chooseAssetForThisMachine, type AssetChoice } from './platform.js';
import { updateOpengrepState } from './state.js';
import {
  OPENGREP_ASSETS,
  OPENGREP_RELEASE_BASE_URL,
  OPENGREP_VERSION,
  type OpengrepAssetName,
  type OpengrepAssetPin,
} from './versions.js';

export type OpengrepInstallPhase = 'downloading' | 'verifying' | 'checking';

export type OpengrepInstallJob = {
  status: 'running' | 'done' | 'failed';
  phase: OpengrepInstallPhase;
  version: string;
  asset: string;
  note?: string;
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
};

export type InstallDeps = {
  fetchImpl?: typeof fetch;
  chooseAsset?: () => Promise<AssetChoice | null>;
  probeVersion?: (command: string) => Promise<string | null>;
  // Test seams: where to put the binary (defaults to the managed path), the
  // release base URL, and the pin table to verify against.
  targetPath?: string;
  releaseBaseUrl?: string;
  assets?: Partial<Record<OpengrepAssetName, OpengrepAssetPin>>;
};

let currentJob: OpengrepInstallJob | null = null;
let inFlight: Promise<void> | null = null;

export function getOpengrepInstallJob(): OpengrepInstallJob | null {
  return currentJob;
}

export class OpengrepInstallError extends Error {}

// Downloads `url` into `dest`, hashing as it streams. Resolves with the digest
// and byte count; rejects (after deleting the partial file) on any failure.
export async function downloadToFile(
  url: string,
  dest: string,
  opts: { fetchImpl?: typeof fetch; onProgress?: (received: number) => void; expectedBytes?: number },
): Promise<{ sha256: string; bytes: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new OpengrepInstallError(`download failed: HTTP ${res.status} for ${url}`);
  }
  const declared = Number(res.headers.get('content-length'));
  if (
    opts.expectedBytes !== undefined &&
    Number.isFinite(declared) &&
    declared > 0 &&
    declared !== opts.expectedBytes
  ) {
    throw new OpengrepInstallError(
      `download size mismatch: the server announced ${declared} bytes, the pin expects ${opts.expectedBytes}. ` +
        'The release asset may have been replaced; not installing.',
    );
  }
  const hash = createHash('sha256');
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      opts.onProgress?.(bytes);
      cb(null, chunk);
    },
  });
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await pipeline(
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
      tap,
      fs.createWriteStream(dest),
    );
  } catch (err) {
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw err;
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function performInstall(job: OpengrepInstallJob, deps: InstallDeps): Promise<void> {
  const assetName = job.asset as OpengrepAssetName;
  const pin = (deps.assets ?? OPENGREP_ASSETS)[assetName];
  if (!pin || !pin.sha256) {
    throw new OpengrepInstallError(
      `no verified digest is pinned for ${assetName}; this Lattice build cannot install it`,
    );
  }
  const url = `${deps.releaseBaseUrl ?? OPENGREP_RELEASE_BASE_URL}/${assetName}`;
  const tmp = path.join(downloadsDir(), `${assetName}.${process.pid}.${Date.now()}.part`);
  job.totalBytes = pin.bytes;

  const { sha256, bytes } = await downloadToFile(url, tmp, {
    fetchImpl: deps.fetchImpl,
    expectedBytes: pin.bytes,
    onProgress: (n) => {
      job.receivedBytes = n;
    },
  });

  job.phase = 'verifying';
  try {
    if (bytes !== pin.bytes) {
      throw new OpengrepInstallError(
        `download incomplete: got ${bytes} bytes, expected ${pin.bytes}. Check the connection and try again.`,
      );
    }
    if (sha256 !== pin.sha256) {
      throw new OpengrepInstallError(
        'download did not match the expected SHA-256 checksum — the file was not installed. ' +
          `Expected ${pin.sha256}, got ${sha256}. A proxy or antivirus rewriting the download, ` +
          'or a replaced release asset, would cause this.',
      );
    }
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }

  const target = deps.targetPath ?? managedBinaryPath(job.version);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  // Replace any previous copy of the same version (a re-install after a
  // quarantine); rename is atomic on the same volume.
  await fsp.rm(target, { force: true }).catch(() => {});
  await fsp.rename(tmp, target);
  if (process.platform !== 'win32') await fsp.chmod(target, 0o755);

  job.phase = 'checking';
  const probe = deps.probeVersion ?? probeOpengrepVersion;
  const version = await probe(target);
  if (!version) {
    let stillThere = true;
    try {
      await fsp.access(target);
    } catch {
      stillThere = false;
    }
    throw new OpengrepInstallError(
      stillThere
        ? `the installed binary did not run (${target}). On Linux/macOS check that the file is executable; on Windows check SmartScreen / antivirus logs.`
        : `the binary vanished right after install (${target}) — your antivirus most likely quarantined it. Add an exclusion for ${managedBinaryDir(job.version)} and try again.`,
    );
  }
  if (version !== job.version) {
    throw new OpengrepInstallError(
      `installed binary reports version ${version}, expected ${job.version}`,
    );
  }
  await updateOpengrepState((s) => ({
    ...s,
    binary: { version: job.version, asset: assetName, sha256, installedAt: Date.now() },
  }));
  resetOpengrepCache();
}

// Starts the install (or returns the running job). The returned snapshot is
// live: poll `getOpengrepInstallJob()` for progress.
export async function startOpengrepInstall(deps: InstallDeps = {}): Promise<OpengrepInstallJob> {
  if (currentJob && currentJob.status === 'running') return currentJob;
  const choice = await (deps.chooseAsset ?? chooseAssetForThisMachine)();
  if (!choice) {
    throw new OpengrepInstallError(
      `no Opengrep build exists for ${process.platform}/${process.arch}. Install Opengrep yourself ` +
        '(https://github.com/opengrep/opengrep/releases) and Lattice will pick it up from PATH.',
    );
  }
  const job: OpengrepInstallJob = {
    status: 'running',
    phase: 'downloading',
    version: OPENGREP_VERSION,
    asset: choice.asset,
    note: choice.note,
    receivedBytes: 0,
    totalBytes: OPENGREP_ASSETS[choice.asset]?.bytes ?? 0,
    startedAt: Date.now(),
  };
  currentJob = job;
  inFlight = performInstall(job, deps)
    .then(() => {
      job.status = 'done';
      job.finishedAt = Date.now();
      console.log(`[opengrep] installed ${job.version} (${job.asset})`);
    })
    .catch((err: unknown) => {
      job.status = 'failed';
      job.finishedAt = Date.now();
      job.error = err instanceof Error ? err.message : String(err);
      console.warn(`[opengrep] install failed: ${job.error}`);
    })
    .finally(() => {
      inFlight = null;
    });
  return job;
}

// Test/route helper: wait for the running install (if any) to settle.
export async function awaitOpengrepInstall(): Promise<OpengrepInstallJob | null> {
  if (inFlight) await inFlight;
  return currentJob;
}
