import { useEffect, useRef, useState } from 'react';
import type { WorkflowVariable } from '../../api';
import { copyVariableToken } from './promptVariables';

// UI-only state for the WorkflowVariablesPanel: which cards are collapsed, the
// info popover toggle, and the transient "Copied!" flag on the variable whose
// `{{token}}` was just click-copied. Kept out of the render components so the
// panel/card JSX stays presentational.
export function useWorkflowVariablesPanelState() {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showInfo, setShowInfo] = useState(false);
  // Id of the variable whose `{{token}}` was just click-copied (drives the
  // brief "Copied!" label swap). A single ref-held timer resets it after ~1.5s.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const toggle = (id: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const copyToken = (v: WorkflowVariable) => {
    // The write can reject (denied permission, non-secure context, unfocused
    // document); only flip to "Copied!" once it has actually landed, otherwise
    // we'd give false success feedback for an empty clipboard.
    void copyVariableToken(v.name).then((ok) => {
      if (!ok) return;
      setCopiedId(v.id);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedId(null), 1500);
    });
  };

  const isCollapsed = (id: string) => collapsed.has(id);

  return { isCollapsed, toggle, showInfo, setShowInfo, copiedId, copyToken };
}
