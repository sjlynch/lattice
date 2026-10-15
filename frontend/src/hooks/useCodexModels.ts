import { useEffect, useState } from 'react';
import { getCodexModels, type CodexModelInfo } from '../api';

// The models Codex lists in its own picker, for the workflow model selects.
// Fetched once per page load and shared by every select; a failed fetch
// leaves the list empty (the select still offers "default" and any saved
// model) and is retried on the next mount.
let cached: CodexModelInfo[] | null = null;
let inflight: Promise<CodexModelInfo[]> | null = null;

export function useCodexModels(enabled: boolean): CodexModelInfo[] {
  const [models, setModels] = useState<CodexModelInfo[]>(cached ?? []);
  useEffect(() => {
    if (!enabled || cached) return;
    let live = true;
    inflight ??= getCodexModels().then(
      (m) => (cached = m),
      () => {
        inflight = null;
        return [];
      },
    );
    void inflight.then((m) => {
      if (live) setModels(m);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return enabled ? models : [];
}
