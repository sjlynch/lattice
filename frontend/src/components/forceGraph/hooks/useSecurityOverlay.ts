import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { runOpengrepGraphScan, type OpengrepGraphFile, type OpengrepGraphResult } from '../../../api/opengrep';
import { securityFilesByPath } from '../securityOverlay';
import { clearLabelsAndRefresh } from './refresh';
import { useOpengrepAvailability } from './useOpengrepAvailability';

type SecurityState = {
  project: string;
  active: boolean;
  scanning: boolean;
  result: OpengrepGraphResult | null;
  error: string | null;
};

export type SecurityOverlayControl = {
  available: boolean;
  active: boolean;
  scanning: boolean;
  result: OpengrepGraphResult | null;
  error: string | null;
  onToggle: () => Promise<void>;
};

// There is no scan effect: only the chip's click handler can POST a scan.
// Each activation runs a fresh scan; clicking an active chip turns the view off.
export function useSecurityOverlay(
  activeFolder: string,
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
) {
  const available = useOpengrepAvailability();
  const [state, setState] = useState<SecurityState | null>(null);
  const folderRef = useRef(activeFolder);
  folderRef.current = activeFolder;
  const requestRef = useRef<AbortController | null>(null);

  // Stop waiting when the project changes or the graph unmounts. An already
  // accepted backend scan may finish and remain stored for its original project.
  useEffect(() => {
    setState(null);
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [activeFolder]);

  useEffect(() => {
    if (available) return;
    requestRef.current?.abort();
    requestRef.current = null;
    setState(null);
  }, [available]);

  const current = state?.project === activeFolder ? state : null;
  const active = available && current?.active === true;
  const result = current?.result ?? null;
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
    if (!activeFolder || !available || requestRef.current) return;
    if (active) {
      setState((s) => s ? { ...s, active: false } : s);
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setState({ project: activeFolder, active: true, scanning: true, result: null, error: null });
    const isCurrent = () => !controller.signal.aborted &&
      requestRef.current === controller && folderRef.current === activeFolder;
    try {
      const scanned = await runOpengrepGraphScan(activeFolder, controller.signal);
      if (isCurrent()) setState({ project: activeFolder, active: true, scanning: false, result: scanned, error: null });
    } catch (err) {
      if (isCurrent()) {
        setState({ project: activeFolder, active: false, scanning: false, result: null,
          error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, [active, activeFolder, available]);

  return {
    securityModeRef,
    securityFilesRef,
    security: {
      available,
      active,
      scanning: current?.scanning === true,
      error: current?.error ?? null,
      result,
      onToggle,
    },
  };
}
