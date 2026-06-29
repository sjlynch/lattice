import { useRef, useState } from 'react';
import type { ScanResult } from '../api';
import {
  useProjectScanScheduler,
  type ProjectScanSnapshot,
} from './projectScanScheduler';

const EMPTY_SCAN_SNAPSHOT: ProjectScanSnapshot = {
  root: '',
  result: null,
  loading: false,
};

export function useProjectScan(activeFolder: string) {
  const [snapshot, setSnapshot] = useState<ProjectScanSnapshot>(EMPTY_SCAN_SNAPSHOT);
  const scanResultRef = useRef<ScanResult | null>(null);

  useProjectScanScheduler({ activeFolder, scanResultRef, setSnapshot });

  // Clear/tag results synchronously on project switch. React state updates from
  // effects run after a render, so deriving the public value from the snapshot's
  // root prevents the previous project's graph from being rendered (or used for
  // graph actions) while the new project's initial scan is still pending.
  const scanResult =
    activeFolder && snapshot.root === activeFolder ? snapshot.result : null;
  const loading = activeFolder
    ? snapshot.root === activeFolder
      ? snapshot.loading
      : true
    : false;

  return { scanResult, loading };
}
