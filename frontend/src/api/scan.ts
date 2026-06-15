// Filesystem-side endpoints: default project root, recursive source scan,
// and folder browser used by the FolderPicker.

import { asJson } from './http';
import type {
  DirListing,
  GitHistoryResult,
  ScanResult,
  SearchResult,
} from './types';

export async function fetchDefaultRoot(): Promise<string> {
  const r = await fetch('/api/default-root');
  const j = await r.json();
  return j.path as string;
}

export async function scanFolder(folderPath: string): Promise<ScanResult> {
  const r = await fetch(`/api/scan?path=${encodeURIComponent(folderPath)}`);
  if (!r.ok) throw new Error(`scan failed: ${r.status}`);
  return r.json();
}

// Contents search across the project's source files. Pass an AbortSignal so a
// superseded (still-typing) request can be cancelled. `regex` selects raw-regex
// vs wildcard interpretation — must match searchMatcher.ts's filename pass.
export async function searchProjectContents(
  project: string,
  opts: { query: string; regex: boolean; signal?: AbortSignal; limit?: number },
): Promise<SearchResult> {
  const params = new URLSearchParams({
    project,
    q: opts.query,
    regex: opts.regex ? '1' : '0',
  });
  if (opts.limit) params.set('limit', String(opts.limit));
  return asJson<SearchResult>(
    await fetch(`/api/search?${params.toString()}`, { signal: opts.signal }),
  );
}

export async function fetchGitHistory(
  folderPath: string,
  limit = 10,
): Promise<GitHistoryResult> {
  const r = await fetch(
    `/api/git-history?path=${encodeURIComponent(folderPath)}&limit=${limit}`,
  );
  if (!r.ok) throw new Error(`git-history failed: ${r.status}`);
  return r.json();
}

export async function listDir(folderPath?: string): Promise<DirListing> {
  const url = folderPath
    ? `/api/list-dir?path=${encodeURIComponent(folderPath)}`
    : '/api/list-dir';
  return asJson<DirListing>(await fetch(url));
}

export async function createDir(parentPath: string, name: string): Promise<DirListing> {
  return asJson<DirListing>(
    await fetch('/api/create-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: parentPath, name }),
    }),
  );
}
