// Pre-run tools for a workflow agent step (`WorkflowStep.tools`). Each tool
// runs BEFORE the harness spawns, writes its report into the step's scratch
// dir beside WORKFLOW_STEP.md, and contributes a paragraph to the brief's
// `{{tool_reports}}` token telling the agent which file to read and what it
// holds. A tool that cannot run (engine missing, no rules, scan busy, scan
// failed) does NOT fail the step: the token carries a one-paragraph
// explanation instead and the step runs — the planner can still do its job
// (and say what happened), whereas a wedged run helps nobody.
//
// v1 ships one tool, `opengrep` → OPENGREP_FINDINGS.md (the digest from
// `opengrep/service.ts`). The shape is a table so `npm audit` / `tsc` / a test
// runner can be added without touching the spawner.

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  OpengrepNoRulesError,
  OpengrepNotInstalledError,
  OpengrepScanAbortedError,
  OpengrepScanBusyError,
  scanProjectWithDigest,
} from '../opengrep/index.js';
import type { WorkflowStep, WorkflowStepTool } from '../workflows/types.js';

export const OPENGREP_REPORT_FILENAME = 'OPENGREP_FINDINGS.md';

// Bound the pre-run so a runaway scan cannot park a workflow run forever; the
// engine's own per-file timeouts keep a healthy scan well under this.
const OPENGREP_STEP_TIMEOUT_MS = 10 * 60_000;

export type StepToolReport = {
  tool: WorkflowStepTool;
  ok: boolean;
  // Absolute path of the report file when one was written.
  file?: string;
  // The paragraph(s) for the brief.
  markdown: string;
};

export type StepToolsDeps = {
  scan?: typeof scanProjectWithDigest;
};

// One AbortController per run whose current step is inside its pre-run, so a
// cancelled run kills its scan instead of leaving the project "busy" (one scan
// per project) for the run the user starts next. `cancelWorkflowRun` calls
// `abortStepPreRun`; the spawner brackets `runStepTools` with begin/end.
const preRuns = new Map<string, AbortController>();

export function beginStepPreRun(runId: string): AbortSignal {
  preRuns.get(runId)?.abort();
  const controller = new AbortController();
  preRuns.set(runId, controller);
  return controller.signal;
}

export function endStepPreRun(runId: string): void {
  preRuns.delete(runId);
}

export function abortStepPreRun(runId: string): boolean {
  const controller = preRuns.get(runId);
  if (!controller) return false;
  preRuns.delete(runId);
  controller.abort();
  return true;
}

async function runOpengrepTool(
  projectPath: string,
  stepDir: string,
  deps: StepToolsDeps,
  signal?: AbortSignal,
): Promise<StepToolReport> {
  const file = path.join(stepDir, OPENGREP_REPORT_FILENAME);
  try {
    const result = await (deps.scan ?? scanProjectWithDigest)(projectPath, {
      timeoutMs: OPENGREP_STEP_TIMEOUT_MS,
      signal,
      render: {
        title: 'Opengrep findings for this workflow step',
        drillDownHint:
          'For the rest, use the `opengrep_findings` MCP tool (rule=<ruleId> narrows to one rule; ' +
          'severity=INFO shows everything) or GET /api/opengrep/scans/latest?project=…&format=md&rule=<ruleId>.',
      },
    });
    try {
      await fs.writeFile(file, result.markdown, 'utf8');
    } catch (err) {
      // The scan itself succeeded and is stored; only the copy beside the
      // brief failed. Say exactly that rather than "the scan failed".
      await fs.rm(file, { force: true }).catch(() => {});
      const why = err instanceof Error ? err.message : String(err);
      console.warn(`[workflow-step] opengrep report could not be written to ${file}: ${why}`);
      return {
        tool: 'opengrep',
        ok: false,
        markdown: [
          '### Opengrep (static analysis) — report file not written',
          '',
          `Lattice scanned the project (scan \`${result.record.id}\`, ${result.digest.shown} finding${result.digest.shown === 1 ? '' : 's'} ` +
            `after the project's filter) but could not write \`${OPENGREP_REPORT_FILENAME}\` here: ${why}.`,
          'Read the digest with the `opengrep_findings` MCP tool (or ' +
            `GET /api/opengrep/scans/${result.record.id}?project=…&format=md) and triage it as if the file were present.`,
          '',
        ].join('\n'),
      };
    }
    const { digest, record } = result;
    const sev = digest.bySeverity;
    const lines = [
      `### Opengrep (static analysis) — read \`${OPENGREP_REPORT_FILENAME}\` in this directory`,
      '',
      `Lattice ran an Opengrep scan of the project just before this step (${record.scannedFiles} files, ` +
        `${record.rulePaths.length} rule source${record.rulePaths.length === 1 ? '' : 's'}, ` +
        `${Math.round(record.durationMs / 1000)}s). ` +
        `**${digest.shown} finding${digest.shown === 1 ? '' : 's'}** across ${digest.groups.length} rule${digest.groups.length === 1 ? '' : 's'} ` +
        `survived the project's filter (${sev.ERROR} ERROR, ${sev.WARNING} WARNING, ${sev.INFO} INFO; ` +
        `${digest.total} raw, ${Math.round(Buffer.byteLength(result.markdown, 'utf8') / 1024)} KB digest).`,
      '',
      'The report is grouped by rule, worst severity first, one short fingerprint (`fp`) per finding.',
      'When you file a task for a finding, put `opengrep:<fp>` on its own line in the task description',
      'and search the board for that marker first (`--find opengrep:<fp>` / `search_tasks`) so a re-run',
      'of this step never files the same finding twice. Findings that are rule noise for this project',
      "belong on the project's Opengrep ignore list, not on the board: add them with the `opengrep_ignore`",
      'MCP tool (or `POST /api/opengrep/ignore` with `{project, ruleIds, fingerprints}`) and say so in',
      'your wrap-up — do not file a task asking a human to do it.',
      '',
    ];
    if (digest.shown === 0) {
      lines.push('_Nothing survived the filter — say so and file no Opengrep tasks unless the raw findings warrant it._', '');
    }
    return { tool: 'opengrep', ok: true, file, markdown: lines.join('\n') };
  } catch (err) {
    const reason =
      err instanceof OpengrepScanAbortedError
        ? 'The workflow run was cancelled while the scan was running.'
        : err instanceof OpengrepNotInstalledError
        ? 'Opengrep is not installed on this machine (Settings → Tools installs it, or put `opengrep` on PATH).'
        : err instanceof OpengrepNoRulesError
          ? 'No Opengrep rule pack is installed/enabled (Settings → Tools).'
          : err instanceof OpengrepScanBusyError
            ? 'Another Opengrep scan of this project was already running.'
            : `The scan failed: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[workflow-step] opengrep pre-run tool did not produce a report: ${reason}`);
    return {
      tool: 'opengrep',
      ok: false,
      markdown: [
        '### Opengrep (static analysis) — no report this run',
        '',
        `This step asked for an Opengrep scan, but it could not run: ${reason}`,
        'Proceed with the step without it (you may run the `opengrep_scan` MCP tool yourself if it is',
        'available), and mention the missing scan in whatever you file.',
        '',
      ].join('\n'),
    };
  }
}

// Runs every tool the step names, in catalog order. Returns the reports plus
// the rendered `{{tool_reports}}` block ('' when the step has no tools).
export async function runStepTools(
  step: Pick<WorkflowStep, 'tools' | 'kind'>,
  projectPath: string,
  stepDir: string,
  deps: StepToolsDeps = {},
  signal?: AbortSignal,
): Promise<{ reports: StepToolReport[]; markdown: string }> {
  const tools = (step.kind ?? 'agent') === 'agent' ? (step.tools ?? []) : [];
  const reports: StepToolReport[] = [];
  for (const tool of tools) {
    if (tool === 'opengrep') reports.push(await runOpengrepTool(projectPath, stepDir, deps, signal));
  }
  if (reports.length === 0) return { reports, markdown: '' };
  const markdown = ['## Tool reports (generated before this step started)', '', ...reports.map((r) => r.markdown)].join('\n');
  return { reports, markdown };
}
