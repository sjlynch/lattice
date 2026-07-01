// Filesystem-side endpoints: default project root, recursive source scan,
// and folder browser used by the FolderPicker.

import { asJson, postJson } from './http';
import { subscribeWs } from './ws';
import type {
  DirListing,
  GitHistoryResult,
  ScanResult,
  SearchResult,
} from './types';

export async function fetchDefaultRoot(): Promise<string> {
  const r = await fetch('/api/default-root');
  // Guard r.ok before r.json(): on a boot-time race the dev proxy can return a
  // non-2xx with an HTML/text body (e.g. a 502 from Vite before :5184 is
  // listening), and r.json() would throw a bare SyntaxError. Throwing a typed,
  // status-bearing error here lets the boot retry path (resolveDefaultRoot)
  // recognise it as a transient failure and back off instead of stranding the
  // app on an empty 'no project' shell.
  if (!r.ok) throw new Error(`default-root failed: ${r.status}`);
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

// Current git branch of the active project folder, for the navbar indicator.
// Returns null when the folder isn't a git repo or the lookup fails — the
// navbar simply omits the branch in that case.
export async function fetchGitBranch(folderPath: string): Promise<string | null> {
  try {
    const r = await fetch(
      `/api/git-branch?path=${encodeURIComponent(folderPath)}`,
    );
    if (!r.ok) return null;
    const j = await r.json();
    return (j.branch as string | null) ?? null;
  } catch {
    return null;
  }
}

export type GitBranchUpdate = { type: 'git-branch'; branch: string | null };

// Live subscription to the active project's current git branch. The backend
// watches `.git/HEAD` and pushes the branch on connect and again whenever it
// changes (a terminal or the user runs `git checkout`), so the navbar chip
// updates without a page refresh. Returns an unsubscribe fn (auto-reconnects
// via subscribeWs). Replaces polling/one-shot fetchGitBranch for the navbar.
export function subscribeGitBranch(
  project: string,
  onBranch: (branch: string | null) => void,
): () => void {
  const url = `/ws/git-branch?project=${encodeURIComponent(project)}`;
  return subscribeWs<GitBranchUpdate>(url, (msg) => {
    if (msg && msg.type === 'git-branch') onBranch(msg.branch ?? null);
  });
}

export async function listDir(folderPath?: string): Promise<DirListing> {
  const url = folderPath
    ? `/api/list-dir?path=${encodeURIComponent(folderPath)}`
    : '/api/list-dir';
  return asJson<DirListing>(await fetch(url));
}

export async function createDir(parentPath: string, name: string): Promise<DirListing> {
  return postJson<DirListing>('/api/create-dir', { parent: parentPath, name });
}
