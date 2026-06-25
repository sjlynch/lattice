import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DirListing } from '../api';
import { loadDirectory, type LoadDirectoryDeps } from '../components/folderPicker/loadDirectory.ts';

function listing(path: string): DirListing {
  return { path, parent: null, entries: [{ name: 'child', path: `${path}/child` }] };
}

type Deferred = {
  promise: Promise<DirListing>;
  resolve: (value: DirListing) => void;
  reject: (err: Error) => void;
};

function deferred(): Deferred {
  let resolve!: (value: DirListing) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<DirListing>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Harness = {
  deps: LoadDirectoryDeps;
  listing: DirListing | null;
  pathInput: string | null;
  selectedPath: string | null;
  error: string | null;
  loading: boolean;
};

function harness(listDir: (target?: string) => Promise<DirListing>): Harness {
  const h: Harness = {
    listing: null,
    pathInput: null,
    selectedPath: 'previously-selected',
    error: 'previous-error',
    loading: false,
    deps: {
      listDir,
      seqRef: { current: 0 },
      setLoading: (v) => {
        h.loading = v;
      },
      setError: (v) => {
        h.error = v;
      },
      setSelectedPath: (v) => {
        h.selectedPath = v;
      },
      setListing: (v) => {
        h.listing = v;
      },
      setPathInput: (v) => {
        h.pathInput = v;
      },
    },
  };
  return h;
}

// The core regression: two overlapping load() calls resolve OUT OF ORDER.
// The first (slower/deeper) navigation must not clobber the second (latest).
test('out-of-order load responses: only the latest navigation wins', async () => {
  const first = deferred();
  const second = deferred();
  const queue = [first.promise, second.promise];
  const h = harness(() => queue.shift()!);

  const p1 = loadDirectory('C:/deep/slow', h.deps);
  const p2 = loadDirectory('C:/latest', h.deps);

  // Resolve the LATEST navigation first, then the stale earlier one.
  second.resolve(listing('C:/latest'));
  await p2;
  first.resolve(listing('C:/deep/slow'));
  await p1;

  assert.equal(h.listing?.path, 'C:/latest', 'listing matches the latest target');
  assert.equal(h.pathInput, 'C:/latest', 'path input matches the latest target');
  // The stale response must not have re-enabled the spinner after the latest cleared it.
  assert.equal(h.loading, false);
});

// In-order resolution still behaves: latest also wins when the earlier one
// resolves first.
test('in-order load responses: the latest navigation still wins', async () => {
  const first = deferred();
  const second = deferred();
  const queue = [first.promise, second.promise];
  const h = harness(() => queue.shift()!);

  const p1 = loadDirectory('C:/first', h.deps);
  const p2 = loadDirectory('C:/second', h.deps);

  first.resolve(listing('C:/first'));
  await p1;
  // The stale earlier response landed, but a newer load is in flight: it must
  // not have shown 'C:/first' as final, and must keep the spinner up.
  assert.notEqual(h.listing?.path, 'C:/first');
  assert.equal(h.loading, true, 'stale response does not clear the spinner');

  second.resolve(listing('C:/second'));
  await p2;
  assert.equal(h.listing?.path, 'C:/second');
  assert.equal(h.pathInput, 'C:/second');
  assert.equal(h.loading, false);
});

// A stale error response must not surface after the latest navigation succeeded.
test('a stale error does not overwrite the latest successful listing', async () => {
  const first = deferred();
  const second = deferred();
  const queue = [first.promise, second.promise];
  const h = harness(() => queue.shift()!);

  const p1 = loadDirectory('C:/will-fail', h.deps);
  const p2 = loadDirectory('C:/ok', h.deps);

  second.resolve(listing('C:/ok'));
  await p2;
  first.reject(new Error('listDir blew up'));
  await p1;

  assert.equal(h.error, null, 'stale error is swallowed');
  assert.equal(h.listing?.path, 'C:/ok');
  assert.equal(h.loading, false);
});

// A single navigation still updates state and clears prior selection/error.
test('a lone load updates listing, clears selection and prior error', async () => {
  const only = deferred();
  const h = harness(() => only.promise);

  const p = loadDirectory('C:/solo', h.deps);
  assert.equal(h.loading, true);
  assert.equal(h.selectedPath, null, 'selection cleared on navigate');
  assert.equal(h.error, null, 'prior error cleared on navigate');

  only.resolve(listing('C:/solo'));
  await p;
  assert.equal(h.listing?.path, 'C:/solo');
  assert.equal(h.pathInput, 'C:/solo');
  assert.equal(h.loading, false);
});
