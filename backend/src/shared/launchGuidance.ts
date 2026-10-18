// Evidence-backed effort suggestions shown in the workflow launch selects
// (never applied automatically). Each line is a measured result from Lattice's
// own benchmarks — keep `why` to the evidence, one sentence:
//   - planning steps: workflow planner steps filing tasks against a pinned old
//     Lattice checkout, valid tasks per minute (codex judge);
//   - task implementers: the replay benchmark — real fixes from this repo's
//     history, the agent gets only the issue text, the fix's hidden tests grade.
// Role: `step` = a workflow step's own agent (planner / reviewer), `tasks` =
// the task agents a Start step launches. Add an entry only with a result
// behind it.

import type { AgentEffort, AgentHarness } from './harnesses.js';

export type LaunchRole = 'step' | 'tasks';

export interface EffortSuggestion {
  effort: AgentEffort;
  why: string;
}

const SUGGESTIONS: ReadonlyArray<{
  harness: AgentHarness;
  role: LaunchRole;
  /** Matched against the selected model id; absent = any model of the harness. */
  model?: RegExp;
} & EffortSuggestion> = [
  {
    harness: 'codex',
    role: 'tasks',
    model: /^gpt-6-luna$/,
    effort: 'medium',
    why:
      '70 real fixes: low passed 9 points fewer; high passed the same at 1.6× the time. ' +
      'Need more? gpt-6.1-sol at low matched luna xhigh in 40% of its time.',
  },
  {
    harness: 'codex',
    role: 'tasks',
    model: /^gpt-6\.1-sol$/,
    effort: 'low',
    why: '31 real fixes: low passed as many as medium and high (77%) in 55-75% of their time.',
  },
  {
    harness: 'codex',
    role: 'tasks',
    model: /^gpt-6-astra$/,
    effort: 'low',
    why:
      '149 real fixes: low passed 126 vs 129 at medium (not significant) in 89% of the time; ' +
      'high passed no more and xhigh took 5×. A precise task spec lifted it 79 → 97 of 98.',
  },
  {
    harness: 'claude',
    role: 'tasks',
    model: /opus/,
    effort: 'low',
    why: '31 real fixes: low passed as many as medium (22) in 60% of the time; high 25 (not significant).',
  },
  {
    harness: 'codex',
    role: 'step',
    effort: 'high',
    why: 'Planning steps: high filed the most valid tasks per minute; xhigh/max ran far longer for no more.',
  },
  {
    harness: 'claude',
    role: 'step',
    effort: 'high',
    why: 'Planning steps: Opus high filed 17 valid tasks in 15 min; xhigh/max had filed none by 22 min.',
  },
];

export function effortSuggestion(
  harness: AgentHarness | undefined,
  model: string | undefined,
  role: LaunchRole,
): EffortSuggestion | undefined {
  if (!harness) return undefined;
  const hit = SUGGESTIONS.find(
    (s) => s.harness === harness && s.role === role && (!s.model || (!!model && s.model.test(model))),
  );
  return hit ? { effort: hit.effort, why: hit.why } : undefined;
}
