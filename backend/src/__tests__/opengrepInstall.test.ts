import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { awaitOpengrepInstall, downloadToFile, startOpengrepInstall } from '../opengrep/install.js';
import { downloadsDir } from '../opengrep/paths.js';
import { readOpengrepState } from '../opengrep/state.js';
import { OPENGREP_VERSION } from '../opengrep/versions.js';

// Writes ~/.lattice/opengrep/state.json — never against a real home (see
// helpers/isolateHome.mjs, preloaded by `npm test`).
if (!process.env.LATTICE_TEST_HOME_ISOLATED) {
  throw new Error(
    'opengrepInstall.test.ts writes under ~/.lattice — run it via `npm test` (or with ' +
      '`--import ./src/__tests__/helpers/isolateHome.mjs`), never bare `node --test`.',
  );
}

// The managed install around a FAKE GitHub: a fetch seam serving bytes of our
// choosing, a pin table of our choosing, and a `--version` probe stub. What is
// pinned is the verification contract — size, then digest, then "does it run"
// — and that nothing lands in the target path unless all three pass.

function fakeFetch(bytes: Buffer, opts: { status?: number; contentLength?: number } = {}): typeof fetch {
  return (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Two chunks so the hashing tap sees more than one write.
        controller.enqueue(bytes.subarray(0, Math.floor(bytes.length / 2)));
        controller.enqueue(bytes.subarray(Math.floor(bytes.length / 2)));
        controller.close();
      },
    });
    const headers = new Headers();
    headers.set('content-length', String(opts.contentLength ?? bytes.length));
    return new Response(stream, { status: opts.status ?? 200, headers });
  }) as unknown as typeof fetch;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-opengrep-install-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('downloadToFile streams, hashes and counts; a declared size that disagrees with the pin is refused up front', async () => {
  await withTmp(async (dir) => {
    const body = Buffer.from('opengrep-binary-bytes-'.repeat(50));
    const dest = path.join(dir, 'a.part');
    const r = await downloadToFile('https://x/y', dest, { fetchImpl: fakeFetch(body), expectedBytes: body.length });
    assert.equal(r.bytes, body.length);
    assert.equal(r.sha256, sha256(body));
    assert.equal((await fs.readFile(dest)).equals(body), true);

    await assert.rejects(
      downloadToFile('https://x/y', path.join(dir, 'b.part'), {
        fetchImpl: fakeFetch(body, { contentLength: body.length + 1 }),
        expectedBytes: body.length,
      }),
      /size mismatch/,
    );
    await assert.rejects(
      downloadToFile('https://x/y', path.join(dir, 'c.part'), { fetchImpl: fakeFetch(body, { status: 404 }) }),
      /HTTP 404/,
    );
  });
});

test('startOpengrepInstall: verified bytes land at the target, run once, and are recorded in state.json', async () => {
  await withTmp(async (dir) => {
    const body = Buffer.from('fake-engine-'.repeat(100));
    const target = path.join(dir, 'bin', 'opengrep.exe');
    const probed: string[] = [];
    const job = await startOpengrepInstall({
      fetchImpl: fakeFetch(body),
      chooseAsset: async () => ({ asset: 'opengrep_windows_x86.exe' }),
      assets: { 'opengrep_windows_x86.exe': { sha256: sha256(body), bytes: body.length } },
      targetPath: target,
      releaseBaseUrl: 'https://fake/release',
      probeVersion: async (cmd) => {
        probed.push(cmd);
        return OPENGREP_VERSION;
      },
    });
    assert.equal(job.status, 'running');
    const done = await awaitOpengrepInstall();
    assert.equal(done?.status, 'done', done?.error);
    assert.equal(done?.receivedBytes, body.length);
    assert.equal(done?.totalBytes, body.length);
    assert.deepEqual(probed, [target]);
    assert.equal((await fs.readFile(target)).equals(body), true);
    const state = await readOpengrepState();
    assert.equal(state.binary?.version, OPENGREP_VERSION);
    assert.equal(state.binary?.sha256, sha256(body));
    assert.equal(state.binary?.asset, 'opengrep_windows_x86.exe');
  });
});

test('startOpengrepInstall: a digest mismatch installs nothing and says why', async () => {
  await withTmp(async (dir) => {
    const body = Buffer.from('tampered-'.repeat(100));
    const target = path.join(dir, 'bin', 'opengrep.exe');
    await startOpengrepInstall({
      fetchImpl: fakeFetch(body),
      chooseAsset: async () => ({ asset: 'opengrep_windows_x86.exe' }),
      assets: { 'opengrep_windows_x86.exe': { sha256: 'f'.repeat(64), bytes: body.length } },
      targetPath: target,
      releaseBaseUrl: 'https://fake/release',
      probeVersion: async () => OPENGREP_VERSION,
    });
    const done = await awaitOpengrepInstall();
    assert.equal(done?.status, 'failed');
    assert.match(done?.error ?? '', /SHA-256 checksum/);
    await assert.rejects(fs.access(target), 'nothing was installed');
    // No stray partial download either.
    const parts = (await fs.readdir(dir)).filter((n) => n.endsWith('.part'));
    assert.deepEqual(parts, []);
  });
});

test('startOpengrepInstall: a binary that vanishes right after install is reported as a likely quarantine', async () => {
  await withTmp(async (dir) => {
    const body = Buffer.from('engine-'.repeat(100));
    const target = path.join(dir, 'bin', 'opengrep.exe');
    await startOpengrepInstall({
      fetchImpl: fakeFetch(body),
      chooseAsset: async () => ({ asset: 'opengrep_windows_x86.exe' }),
      assets: { 'opengrep_windows_x86.exe': { sha256: sha256(body), bytes: body.length } },
      targetPath: target,
      releaseBaseUrl: 'https://fake/release',
      probeVersion: async (cmd) => {
        await fs.rm(cmd, { force: true }); // the "antivirus"
        return null;
      },
    });
    const done = await awaitOpengrepInstall();
    assert.equal(done?.status, 'failed');
    assert.match(done?.error ?? '', /antivirus|quarantine/i);
  });
});

test('startOpengrepInstall: an unsupported platform is refused before anything is fetched', async () => {
  let fetched = 0;
  await assert.rejects(
    startOpengrepInstall({
      fetchImpl: (async () => {
        fetched += 1;
        return new Response('x');
      }) as unknown as typeof fetch,
      chooseAsset: async () => null,
    }),
    /no Opengrep build exists/,
  );
  assert.equal(fetched, 0);
});

async function partFiles(): Promise<string[]> {
  return (await fs.readdir(downloadsDir()).catch(() => [] as string[])).filter((n) => n.endsWith('.part'));
}

test('startOpengrepInstall: a rename that fails AFTER verification leaves no verified .part behind in downloads/', async () => {
  await withTmp(async (dir) => {
    const body = Buffer.from('verified-engine-'.repeat(100));
    // A non-empty DIRECTORY where the binary goes: the best-effort rm of the
    // old target cannot remove it, so the rename onto it fails (EISDIR /
    // EPERM) — the stand-in for Windows AV / a running opengrep.exe.
    const target = path.join(dir, 'bin', 'opengrep.exe');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'occupied'), 'x');
    await startOpengrepInstall({
      fetchImpl: fakeFetch(body),
      chooseAsset: async () => ({ asset: 'opengrep_windows_x86.exe' }),
      assets: { 'opengrep_windows_x86.exe': { sha256: sha256(body), bytes: body.length } },
      targetPath: target,
      releaseBaseUrl: 'https://fake/release',
      probeVersion: async () => OPENGREP_VERSION,
    });
    const done = await awaitOpengrepInstall();
    assert.equal(done?.status, 'failed');
    assert.deepEqual(await partFiles(), [], 'the ~50 MB verified download was removed');
  });
});

test('startOpengrepInstall: stale .part files a killed transfer left in downloads/ are swept when the next install starts', async () => {
  await withTmp(async (dir) => {
    await fs.mkdir(downloadsDir(), { recursive: true });
    const stale = path.join(downloadsDir(), 'opengrep_windows_x86.exe.99999.1.part');
    await fs.writeFile(stale, 'half a download');
    const body = Buffer.from('engine-bytes-'.repeat(100));
    await startOpengrepInstall({
      fetchImpl: fakeFetch(body),
      chooseAsset: async () => ({ asset: 'opengrep_windows_x86.exe' }),
      assets: { 'opengrep_windows_x86.exe': { sha256: sha256(body), bytes: body.length } },
      targetPath: path.join(dir, 'bin', 'opengrep.exe'),
      releaseBaseUrl: 'https://fake/release',
      probeVersion: async () => OPENGREP_VERSION,
    });
    const done = await awaitOpengrepInstall();
    assert.equal(done?.status, 'done', done?.error);
    assert.deepEqual(await partFiles(), []);
  });
});

test('startOpengrepInstall: two quick starts share ONE install even while the asset choice is still pending', async () => {
  await withTmp(async (dir) => {
    const body = Buffer.from('single-flight-'.repeat(100));
    let releaseChoice!: () => void;
    const choicePending = new Promise<void>((r) => {
      releaseChoice = r;
    });
    let downloads = 0;
    const fetchOnce = fakeFetch(body);
    const deps = {
      fetchImpl: ((...args: Parameters<typeof fetch>) => {
        downloads += 1;
        return fetchOnce(...args);
      }) as typeof fetch,
      // Deferred: the real one does file I/O (musl detection) on Linux, and the
      // second POST used to slip past the running-job check during that await.
      chooseAsset: async () => {
        await choicePending;
        return { asset: 'opengrep_windows_x86.exe' as const };
      },
      assets: { 'opengrep_windows_x86.exe': { sha256: sha256(body), bytes: body.length } },
      targetPath: path.join(dir, 'bin', 'opengrep.exe'),
      releaseBaseUrl: 'https://fake/release',
      probeVersion: async () => OPENGREP_VERSION,
    };
    const first = startOpengrepInstall(deps);
    const second = startOpengrepInstall(deps);
    releaseChoice();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b, 'both callers get the same job');
    const done = await awaitOpengrepInstall();
    assert.equal(done?.status, 'done', done?.error);
    assert.equal(downloads, 1, 'only one download started');
  });
});
