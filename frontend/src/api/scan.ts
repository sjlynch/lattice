// Filesystem-side endpoints: default project root, recursive source scan,
// and folder browser used by the FolderPicker.

import { asJson } from './http';
import type { DirListing, GitHistoryResult, ScanResult } from './types';

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
