import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { cancelOpengrepGraphScan, runOpengrepGraphScan, waitForOpengrepGraphScan, type OpengrepGraphFile, type OpengrepGraphResult } from '../../../api/opengrep';
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
};

type SecurityRequest = {
  controller: AbortController;
  scanId: string | null;
  cancelRequested: boolean;
  cancelPromise: Promise<void> | null;
  cancel: () => Promise<void>;
};

// Only the chip's click handler can POST a scan. Status reads let a refreshed
// graph reconnect to an already running scan without starting another one.
// Each activation runs a fresh scan; clicking an active chip turns the view off.
export function useSecurityOverlay(
  activeFolder: string,
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
) {
  const { available, projectStatus } = useOpengrepAvailability(activeFolder);
  const [state, setState] = useState<SecurityState | null>(null);
  const folderRef = useRef(activeFolder);
  folderRef.current = activeFolder;
  const requestRef = useRef<SecurityRequest | null>(null);
  const observedScanRef = useRef<string | null>(null);

  // Stop waiting when the project changes or the graph unmounts. An already
  // accepted backend scan may finish and remain stored for its original project.
  useEffect(() => {
    setState(null);
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
  const watchScan = useCallback(async (scan?: { id: string; startedAt: number }) => {
    if (requestRef.current) return;
    const controller = new AbortController();
    const request: SecurityRequest = {
      controller, scanId: scan?.id ?? null, cancelRequested: false, cancelPromise: null,
      cancel: () => {
        if (!request.scanId) return Promise.resolve(); // acceptance will honor the intent
        if (request.cancelPromise) return request.cancelPromise;
        request.cancelPromise = cancelOpengrepGraphScan(activeFolder, request.scanId, controller.signal)
          .then(() => {
            if (!isCurrent()) return;
            controller.abort();
            requestRef.current = null;
            setState(null);
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
    setState({ project: activeFolder, active: true, scanning: true, cancelling: false,
      startedAt: scan?.startedAt ?? Date.now(),
      estimatedDurationMs: duration && duration > 0 ? duration : null,
      result: null, error: null });
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
        });
      if (request.cancelPromise) await request.cancelPromise;
      if (isCurrent()) {
        observedScanRef.current = scanned.scan.id;
        setState((s) => s ? { ...s, active: true, scanning: false, cancelling: false, result: scanned, error: null } : s);
      }
    } catch (err) {
      if (request.cancelPromise) await request.cancelPromise;
      if (isCurrent()) {
        setState((s) => s ? { ...s, active: false, scanning: false, cancelling: false, result: null,
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

  const current = state?.project === activeFolder ? state : null;
  const result = current?.result ?? null;
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
    if (active) {
      setState((s) => s ? { ...s, active: false } : s);
      return;
    }
    await watchScan();
  }, [active, activeFolder, available, watchScan]);

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
    },
  };
}
