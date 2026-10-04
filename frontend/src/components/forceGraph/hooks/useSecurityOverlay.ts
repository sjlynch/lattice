import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { cancelOpengrepGraphScan, fetchOpengrepGraphResult, runOpengrepGraphScan, waitForOpengrepGraphScan, type OpengrepGraphFile, type OpengrepGraphResult } from '../../../api/opengrep';
import { DEFAULT_SECURITY_FILTER, filteredSecurityResult, type SecurityFilter } from '../securityFindings';
import { HttpError, subscribeGitStatus } from '../../../api';
import { securityFilesByPath } from '../securityOverlay';
import { clearLabelsAndRefresh } from './refresh';
import { useOpengrepAvailability } from './useOpengrepAvailability';

type SecurityState = {
  project: string;
  active: boolean;
  scanning: boolean;
  cancelling: boolean;
  startedAt: number;
  estimatedDurationMs: number | null;
  result: OpengrepGraphResult | null;
  error: string | null;
};

export type SecurityOverlayControl = {
  available: boolean;
  active: boolean;
  scanning: boolean;
  cancelling: boolean;
  startedAt: number | null;
  estimatedDurationMs: number | null;
  result: OpengrepGraphResult | null;
  error: string | null;
  onToggle: () => Promise<void>;
  onScan?: (mode: 'full' | 'incremental') => Promise<void>;
  onShowFindings?: (path?: string) => void;
  onCloseFindings?: () => void;
  panelOpen?: boolean;
  panelFile?: string | null;
  filter?: SecurityFilter;
  onFilterChange?: (filter: SecurityFilter) => void;
  restoring?: boolean;
  onFocusFile?: (path: string) => void;
  onRefresh?: () => Promise<void>;
};

type SecurityRequest = {
  controller: AbortController;
  scanId: string | null;
  cancelRequested: boolean;
  cancelPromise: Promise<void> | null;
  cancel: () => Promise<void>;
};

// Only explicit scan actions POST. Status reads reconnect to an already running
// scan; saved snapshots restore independently. The chip toggles saved results
// when idle and cancels its exact scan while busy.
export function useSecurityOverlay(
  activeFolder: string,
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
) {
  const { available, projectStatus } = useOpengrepAvailability(activeFolder);
  const [state, setState] = useState<SecurityState | null>(null);
  const [filter, setFilter] = useState(DEFAULT_SECURITY_FILTER);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelFile, setPanelFile] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const folderRef = useRef(activeFolder);
  folderRef.current = activeFolder;
  const requestRef = useRef<SecurityRequest | null>(null);
  const observedScanRef = useRef<string | null>(null);

  // Stop waiting when the project changes or the graph unmounts. An already
  // accepted backend scan may finish and remain stored for its original project.
  useEffect(() => {
    setState(null);
    setRestoring(false);
    setFilter(DEFAULT_SECURITY_FILTER); setPanelOpen(false); setPanelFile(null);
    observedScanRef.current = null;
    return () => {
      requestRef.current?.controller.abort();
      requestRef.current = null;
    };
  }, [activeFolder]);

  useEffect(() => {
    if (available) return;
    requestRef.current?.controller.abort();
    requestRef.current = null;
    setState(null);
  }, [available]);

  const previousScan = state?.project === activeFolder ? state.result?.scan : null;
  const duration = previousScan?.durationMs ?? projectStatus?.lastScan?.durationMs;
  const watchScan = useCallback(async (scan?: { id: string; startedAt: number }, mode: 'full' | 'incremental' = 'full') => {
    if (requestRef.current) return;
    const controller = new AbortController();
    const request: SecurityRequest = {
      controller, scanId: scan?.id ?? null, cancelRequested: false, cancelPromise: null,
      cancel: () => {
        if (!request.scanId) return Promise.resolve(); // acceptance will honor the intent
        if (request.cancelPromise) return request.cancelPromise;
        request.cancelPromise = cancelOpengrepGraphScan(activeFolder, request.scanId, controller.signal)
          .then(({ cancelled }) => {
            if (!isCurrent()) return;
            if (!cancelled) {
              request.cancelRequested = false; request.cancelPromise = null;
              setState((s) => s ? { ...s, cancelling: false } : s);
              return;
            }
            controller.abort();
            requestRef.current = null;
            setState((s) => s?.result ? { ...s, scanning: false, cancelling: false, error: null } : null);
          }).catch((err: unknown) => {
            if (!isCurrent()) return;
            request.cancelRequested = false;
            request.cancelPromise = null;
            setState((s) => s ? { ...s, cancelling: false,
              error: err instanceof Error ? err.message : String(err) } : s);
          });
        return request.cancelPromise;
      },
    };
    requestRef.current = request;
    if (scan) observedScanRef.current = scan.id;
    setState((s) => ({ project: activeFolder, active: true, scanning: true, cancelling: false,
      startedAt: scan?.startedAt ?? Date.now(),
      estimatedDurationMs: duration && duration > 0 ? duration : null,
      result: s?.project === activeFolder ? s.result : null, error: null }));
    const isCurrent = () => !controller.signal.aborted &&
      requestRef.current === request && folderRef.current === activeFolder;
    try {
      const scanned = scan
        ? await waitForOpengrepGraphScan(activeFolder, scan.id, controller.signal)
        : await runOpengrepGraphScan(activeFolder, controller.signal, (accepted) => {
          request.scanId = accepted.id;
          if (!isCurrent()) return;
          observedScanRef.current = accepted.id;
          const startedAt = accepted.startedAt;
          if (startedAt !== undefined) {
            setState((s) => s ? { ...s, startedAt } : s);
          }
          if (request.cancelRequested) void request.cancel();
        }, mode);
      if (request.cancelPromise) await request.cancelPromise;
      if (isCurrent()) {
        observedScanRef.current = scanned.scan.id;
        setState((s) => s ? { ...s, active: true, scanning: false, cancelling: false, result: scanned, error: null } : s);
        try { localStorage.setItem(`lattice.security.${activeFolder}`, 'on'); } catch { /* optional storage */ }
      }
    } catch (err) {
      if (request.cancelPromise) await request.cancelPromise;
      if (isCurrent()) {
        setState((s) => s ? { ...s, active: !!s.result, scanning: false, cancelling: false,
          error: err instanceof Error ? err.message : String(err) } : s);
      }
    } finally {
      if (requestRef.current === request) requestRef.current = null;
    }
  }, [activeFolder, duration]);

  useEffect(() => {
    const scan = projectStatus?.runningScan;
    if (!available || !activeFolder || !scan || observedScanRef.current === scan.id) return;
    void watchScan(scan);
  }, [activeFolder, available, projectStatus, watchScan]);

  const latestId = previousScan?.id ?? projectStatus?.lastScan?.id;
  useEffect(() => {
    if (!available || !activeFolder || !latestId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    const refresh = async () => {
      if (busy || document.visibilityState === 'hidden') return;
      busy = true; setRestoring(true);
      try {
        const result = await fetchOpengrepGraphResult(activeFolder, 'latest', controller.signal);
        if (controller.signal.aborted || folderRef.current !== activeFolder) return;
        // A late background read cannot replace a newer completed scan.
        setState((s) => {
          if (s?.project === activeFolder && s.result && s.result.scan.startedAt > result.scan.startedAt) return s;
          if (s?.project === activeFolder && s.result?.scan.id === result.scan.id &&
              JSON.stringify(s.result.files) === JSON.stringify(result.files) &&
              JSON.stringify(s.result.filter) === JSON.stringify(result.filter) &&
              JSON.stringify(s.result.allFindings) === JSON.stringify(result.allFindings) &&
              s.result.freshness?.state === result.freshness?.state &&
              s.result.freshness?.changedFiles === result.freshness?.changedFiles &&
              s.result.freshness?.configurationChanged === result.freshness?.configurationChanged) return s;
          let active = true;
          try { active = localStorage.getItem(`lattice.security.${activeFolder}`) !== 'off'; } catch { /* optional storage */ }
          return s?.project === activeFolder ? { ...s, result } : { project: activeFolder,
            active, scanning: false, cancelling: false, startedAt: result.scan.startedAt,
            estimatedDurationMs: null, result, error: null };
        });
      } catch (err) {
        if (!controller.signal.aborted && !(err instanceof HttpError && err.status === 404))
          setState((s) => s ? { ...s, error: `Could not refresh saved findings: ${err instanceof Error ? err.message : String(err)}` } : s);
      } finally { busy = false; if (!controller.signal.aborted) setRestoring(false); }
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 1200); };
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    // A git/tree change only checks freshness; it never starts a scan.
    const unsubscribe = typeof WebSocket === 'undefined' || !window.location ? () => {} : subscribeGitStatus(activeFolder, schedule);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    void refresh();
    const poll = setInterval(onVisible, 30_000);
    return () => { controller.abort(); clearTimeout(timer); clearInterval(poll); unsubscribe();
      window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible); };
  }, [activeFolder, available, latestId]);

  const current = state?.project === activeFolder ? state : null;
  const result = useMemo(() => current?.result ? filteredSecurityResult(current.result, filter) : null, [current?.result, filter]);
  // Waiting must not apply Security's node visibility/recolor rules to a graph
  // with no findings yet. Keep the normal view until the snapshot is ready.
  const active = available && current?.active === true && result !== null;
  const files = useMemo(() => result ? securityFilesByPath(result) : null, [result]);
  const securityModeRef = useRef(false);
  const securityFilesRef = useRef<ReadonlyMap<string, OpengrepGraphFile> | null>(null);
  securityModeRef.current = active;
  securityFilesRef.current = active ? files : null;

  const previousRef = useRef({ active: false, files });
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { active, files };
    if (active !== previous.active || (active && files !== previous.files)) {
      clearLabelsAndRefresh(graphRef.current);
    }
  }, [active, files, graphRef]);

  const onToggle = useCallback(async () => {
    if (!activeFolder || !available) return;
    const request = requestRef.current;
    if (request) {
      if (request.cancelRequested) return;
      request.cancelRequested = true;
      setState((s) => s ? { ...s, cancelling: true, error: null } : s);
      await request.cancel();
      return;
    }
    if (result) {
      setState((s) => s ? { ...s, active: !s.active } : s);
      try { localStorage.setItem(`lattice.security.${activeFolder}`, active ? 'off' : 'on'); } catch { /* optional storage */ }
      return;
    }
    await watchScan();
  }, [active, activeFolder, available, watchScan, result]);

  const onScan = useCallback((mode: 'full' | 'incremental') => watchScan(undefined, mode), [watchScan]);
  const onShowFindings = useCallback((path?: string) => { setPanelFile(path ?? null); setPanelOpen(true); }, []);
  const onCloseFindings = useCallback(() => setPanelOpen(false), []);
  const onRefresh = useCallback(async () => {
    const result = await fetchOpengrepGraphResult(activeFolder);
    if (folderRef.current !== activeFolder) return;
    setState((s) => s?.project === activeFolder && (!s.result || s.result.scan.startedAt <= result.scan.startedAt) ? { ...s, result } : s);
  }, [activeFolder]);

  return {
    securityModeRef,
    securityFilesRef,
    security: {
      available,
      active,
      scanning: current?.scanning === true,
      cancelling: current?.cancelling === true,
      startedAt: current?.startedAt ?? null,
      estimatedDurationMs: current?.estimatedDurationMs ?? null,
      error: current?.error ?? null,
      result,
      onToggle,
      onScan, onShowFindings, onCloseFindings, onRefresh, panelOpen, panelFile, filter, onFilterChange: setFilter, restoring,
    },
  };
}
