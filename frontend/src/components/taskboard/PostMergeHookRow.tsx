import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Webhook, X } from 'lucide-react';
import {
  availableAgentHarnesses,
  harnessLabel,
  type AgentHarness,
  type HarnessAvailability,
} from '../../harnesses';
import type { PostMergeHookRun } from '../../api';

type Props = {
  prompt: string;
  harness: AgentHarness;
  harnessAvail: HarnessAvailability;
  active: PostMergeHookRun | null;
  recent: PostMergeHookRun | null;
  saving: boolean;
  onSavePrompt: (value: string) => void;
  onSaveHarness: (harness: AgentHarness) => void;
  onAbort: () => void;
  onFocusActiveTerminal: (() => void) | null;
};

// Status chip shown in the collapsed strip. The active state is the strong
// signal (it pulses); the recent state degrades to a quieter result label.
function statusLabel(active: PostMergeHookRun | null, recent: PostMergeHookRun | null, configured: boolean): { text: string; tone: 'running' | 'ok' | 'warn' | 'idle' | 'off' } {
  if (active) return { text: 'Hook running', tone: 'running' };
  if (recent) {
    if (recent.status === 'completed') return { text: 'Last hook: ok', tone: 'ok' };
    if (recent.status === 'aborted') return { text: 'Last hook: aborted', tone: 'warn' };
    if (recent.status === 'errored') return { text: 'Last hook: error', tone: 'warn' };
  }
  return configured ? { text: 'Configured', tone: 'idle' } : { text: 'Off', tone: 'off' };
}

export function PostMergeHookRow({
  prompt,
  harness,
  harnessAvail,
  active,
  recent,
  saving,
  onSavePrompt,
  onSaveHarness,
  onAbort,
  onFocusActiveTerminal,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState(prompt);
  const draftRef = useRef(prompt);

  // Keep local draft in sync with persisted value when it changes externally
  // (folder switch, another tab updating settings, etc.).
  useEffect(() => {
    if (prompt !== draftRef.current) {
      setDraftPrompt(prompt);
      draftRef.current = prompt;
    }
  }, [prompt]);

  // Debounced persist on prompt edits — same pattern as other settings
  // controls in the codebase (250 ms balances "feels live" with not
  // hammering the file-write side of /api/settings).
  useEffect(() => {
    if (draftPrompt === prompt) return;
    const handle = window.setTimeout(() => {
      draftRef.current = draftPrompt;
      onSavePrompt(draftPrompt);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [draftPrompt, prompt, onSavePrompt]);

  const configured = prompt.trim().length > 0;
  const status = statusLabel(active, recent, configured);
  const harnessOptions = availableAgentHarnesses(harnessAvail, harness);

  const onPromptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => setDraftPrompt(e.target.value),
    [],
  );

  return (
    <div
      className={`post-merge-hook-row${expanded ? ' expanded' : ''}${active ? ' running' : ''}`}
      data-tone={status.tone}
    >
      <button
        type="button"
        className="post-merge-hook-strip"
        onClick={() => setExpanded((v) => !v)}
        title={
          expanded
            ? 'Collapse post-merge hook'
            : 'Configure a post-merge hook (blocks workflow advancement until it finishes)'
        }
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Webhook size={12} aria-hidden />
        <span className="post-merge-hook-label">Post-merge hook</span>
        <span className={`post-merge-hook-chip post-merge-hook-chip-${status.tone}`}>
          {status.text}
        </span>
        {configured && !active && (
          <span className="post-merge-hook-preview" title={prompt}>
            {prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt}
          </span>
        )}
        {saving && <span className="post-merge-hook-saving">saving…</span>}
      </button>

      {active && (
        <div className="post-merge-hook-banner">
          <span>
            Hook agent ({harnessLabel(active.harness)}) is running — workflows
            waiting on this merge are blocked until it finishes.
          </span>
          {onFocusActiveTerminal && (
            <button
              type="button"
              className="post-merge-hook-btn-ghost"
              onClick={onFocusActiveTerminal}
            >
              Open terminal
            </button>
          )}
          <button
            type="button"
            className="post-merge-hook-btn-danger"
            onClick={onAbort}
            title="Abort the hook — releases the merge-step gate"
          >
            <X size={11} />
            Abort
          </button>
        </div>
      )}

      {expanded && (
        <div className="post-merge-hook-form">
          <textarea
            className="post-merge-hook-textarea"
            placeholder={
              'e.g. Run the test suite, and if anything is broken, commit a one-line fix.\n\nLeave blank to disable.'
            }
            value={draftPrompt}
            onChange={onPromptChange}
            rows={4}
            spellCheck={false}
          />
          <div className="post-merge-hook-form-row">
            <label className="post-merge-hook-field">
              <span>Harness</span>
              <select
                value={harness}
                onChange={(e) => onSaveHarness(e.target.value as AgentHarness)}
              >
                {harnessOptions.map((option) => (
                  <option key={option} value={option}>
                    {harnessLabel(option)}
                  </option>
                ))}
              </select>
            </label>
            <span className="post-merge-hook-hint">
              Fires after each successful merge. The merge step waits for this
              agent's Stop hook before completing.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
