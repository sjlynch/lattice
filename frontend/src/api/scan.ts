// Filesystem-side endpoints: default project root, recursive source scan,
// and folder browser used by the FolderPicker.

import type { DirListing, ScanResult } from './types';

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

export async function listDir(folderPath?: string): Promise<DirListing> {
  const url = folderPath
    ? `/api/list-dir?path=${encodeURIComponent(folderPath)}`
    : '/api/list-dir';
  const r = await fetch(url);
  if (!r.ok) throw new Error(`list-dir failed: ${r.status}`);
  return r.json();
}
