import { useEffect, useRef, useState } from 'react';
import { fetchUserSettingsStrict, type UserSettings } from '../../api';

export function taskWritingRulesFromText(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

type TaskWritingPatch = Pick<UserSettings, 'taskWritingRules' | 'plannerSpecGaps'>;

// Keep edits through tab switches, suppress patches across project/open changes,
// and never let a late settings GET replace a field already edited by the user.
export function useTaskWritingDraft(open: boolean, activeFolder: string) {
  const [rulesText, setRulesText] = useState('');
  const [showGaps, setShowGaps] = useState(true);
  const [project, setProject] = useState('');
  const touched = useRef({ rules: false, gaps: false });
  useEffect(() => {
    touched.current = { rules: false, gaps: false };
    setProject(open ? activeFolder : '');
    setRulesText('');
    setShowGaps(true);
    if (!open || !activeFolder) return;
    let cancelled = false;
    fetchUserSettingsStrict(activeFolder).then((settings) => {
      if (cancelled) return;
      if (!touched.current.rules) setRulesText((settings.taskWritingRules ?? []).join('\n'));
      if (!touched.current.gaps) setShowGaps(settings.plannerSpecGaps !== false);
    }).catch(() => { /* untouched fields never produce a patch */ });
    return () => { cancelled = true; };
  }, [open, activeFolder]);

  return {
    rulesText,
    showGaps,
    setRulesText: (text: string) => {
      touched.current.rules = true;
      setRulesText(text);
    },
    setShowGaps: (value: boolean) => {
      touched.current.gaps = true;
      setShowGaps(value);
    },
    getPatch: (): TaskWritingPatch | undefined => {
      if (!open || !activeFolder || project !== activeFolder) return undefined;
      const patch: TaskWritingPatch = {};
      if (touched.current.rules) patch.taskWritingRules = taskWritingRulesFromText(rulesText);
      if (touched.current.gaps) patch.plannerSpecGaps = showGaps;
      return Object.keys(patch).length ? patch : undefined;
    },
  };
}
