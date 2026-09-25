import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HttpError,
  fetchGlobalSettings,
  fetchOpengrepStatus,
  fetchUserSettingsStrict,
  runOpengrepScan,
  type OpengrepScanEnvelope,
  type OpengrepStatus,
} from '../../../api';
import { EMPTY_DRAFT, POLL_MS, draftFromSettings, type ProjectDraft } from './toolsTabUtils';

// All of the Tools tab's state: the Opengrep status (+ polling while a job or
// scan runs), the machine-global pack-enable draft, this project's scan-filter
// draft, and the "Run scan" result. `ToolsTab` wires the imperative Save handle
// from the returned drafts + loaded/touched flags.
export function useOpengrepToolsState(open: boolean, activeFolder: string) {
  const [status, setStatus] = useState<OpengrepStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [packDraft, setPackDraft] = useState<Record<string, boolean>>({});
  const [packTouched, setPackTouched] = useState(false);
  const [packLoaded, setPackLoaded] = useState(false);
  const [packLoadError, setPackLoadError] = useState<string | null>(null);

  const [draft, setDraft] = useState<ProjectDraft>(EMPTY_DRAFT);
  const [projectTouched, setProjectTouched] = useState(false);
  const [projectLoaded, setProjectLoaded] = useState(false);
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);

  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<OpengrepScanEnvelope | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const openRef = useRef(open);
  openRef.current = open;
  // The folder the tab is currently showing. The panel has no backdrop, so the
  // active folder can change while a status request for the previous one is
  // still in flight; its late answer must not overwrite the new folder's.
  const folderRef = useRef(activeFolder);
  folderRef.current = activeFolder;

  const refreshStatus = useCallback(async () => {
    const folder = activeFolder;
    try {
      const s = await fetchOpengrepStatus(folder || undefined);
      if (!openRef.current || folderRef.current !== folder) return null;
      setStatus(s);
      setStatusError(null);
      return s;
    } catch (err) {
      if (openRef.current && folderRef.current === folder) setStatusError((err as Error).message);
      return null;
    }
  }, [activeFolder]);

  // (Re)load everything each time the dialog opens. Both loads flip their
  // `loaded` flag ONLY on success: the Save patch is the whole `opengrep`
  // object (resp. the whole `packs` map), so a failed fetch taken as "empty"
  // would have Save erase the lists the project already has — including the
  // fingerprints agents appended through `opengrep_ignore`. Until a load
  // succeeds the controls stay disabled and the error says why.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus(null);
    setStatusError(null);
    setPackLoaded(false);
    setPackTouched(false);
    setPackLoadError(null);
    setProjectLoaded(false);
    setProjectTouched(false);
    setProjectLoadError(null);
    setDraft(EMPTY_DRAFT);
    setScanResult(null);
    setScanError(null);
    setActionError(null);
    void refreshStatus();
    fetchGlobalSettings()
      .then((g) => {
        if (cancelled) return;
        setPackDraft({ ...(g.opengrep?.packs ?? {}) });
        setPackLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPackLoadError(
          `Could not load the machine-global settings (${(err as Error).message || String(err)}); ` +
            'the pack enables are read-only until the dialog is reopened.',
        );
      });
    if (activeFolder) {
      fetchUserSettingsStrict(activeFolder)
        .then((u) => {
          if (cancelled) return;
          setDraft(draftFromSettings(u.opengrep));
          setProjectLoaded(true);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setProjectLoadError(
            `Could not load this project's settings (${(err as Error).message || String(err)}); ` +
              'the scan filter is read-only until the dialog is reopened.',
          );
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, activeFolder, refreshStatus]);

  // Poll while something is in flight (engine install, a pack fetch, a scan).
  const busy =
    status?.installJob?.status === 'running' ||
    status?.packs.some((p) => p.job?.status === 'running') === true ||
    status?.project?.scanning === true ||
    scanning;
  useEffect(() => {
    if (!open || !busy) return;
    const t = setInterval(() => void refreshStatus(), POLL_MS);
    return () => clearInterval(t);
  }, [open, busy, refreshStatus]);

  const runAction = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError((err as Error).message || String(err));
    }
    await refreshStatus();
  };

  const onScan = async () => {
    if (!activeFolder) return;
    const folder = activeFolder;
    setScanning(true);
    setScanError(null);
    setScanResult(null);
    try {
      const r = await runOpengrepScan(folder);
      // A scan outlives a project switch (the panel has no backdrop); its
      // result belongs to the folder it scanned, not the one now showing.
      if (folderRef.current === folder) setScanResult(r);
    } catch (err) {
      const e = err as HttpError;
      if (folderRef.current === folder) {
        setScanError(e.code ? `${e.message} (${e.code})` : e.message || String(err));
      }
    } finally {
      setScanning(false);
      await refreshStatus();
    }
  };

  const patchDraft = (p: Partial<ProjectDraft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setProjectTouched(true);
  };

  const setPackEnabled = (packId: string, enabled: boolean) => {
    setPackDraft((d) => ({ ...d, [packId]: enabled }));
    setPackTouched(true);
  };

  return {
    status,
    statusError,
    actionError,
    packDraft,
    packTouched,
    packLoaded,
    packLoadError,
    draft,
    projectTouched,
    projectLoaded,
    projectLoadError,
    scanning,
    scanResult,
    scanError,
    refreshStatus,
    runAction,
    onScan,
    patchDraft,
    setPackEnabled,
  };
}
