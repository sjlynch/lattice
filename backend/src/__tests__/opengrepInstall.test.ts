import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { awaitOpengrepInstall, downloadToFile, startOpengrepInstall } from '../opengrep/install.js';
import { readOpengrepState } from '../opengrep/state.js';
import { OPENGREP_VERSION } from '../opengrep/versions.js';

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
