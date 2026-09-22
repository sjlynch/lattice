import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  OpengrepNotInstalledError,
  OpengrepScanAbortedError,
  OpengrepScanBusyError,
} from '../opengrep/index.js';
import type { ScanWithDigestResult } from '../opengrep/service.js';
import { DEFAULT_WORKFLOW_STEP_TEMPLATE } from '../instructionTemplates/defs.js';
import { renderStepMarkdown } from '../workflowRuns/stepMarkdown.js';
import {
  OPENGREP_REPORT_FILENAME,
  abortStepPreRun,
  beginStepPreRun,
  endStepPreRun,
  runStepTools,
} from '../workflowRuns/stepTools.js';
import { normalizeStepTools } from '../workflows/normalization.js';
import type { Workflow } from '../workflows.js';
import type { WorkflowRun } from '../workflowRuns/state.js';
import { withTempDir } from './helpers/tempDir.js';

// A workflow agent step with `tools: ['opengrep']` scans the project BEFORE
// its harness spawns and gets the digest as a file beside WORKFLOW_STEP.md,
// pointed at by the brief's `{{tool_reports}}` section. The contract worth
// pinning: the file lands, the brief names it, and — the load-bearing one — a
// tool that cannot run explains itself in the brief instead of failing the
// step.

const PROJECT = 'C:\\proj';

function fakeResult(overrides: Partial<ScanWithDigestResult['digest']> = {}): ScanWithDigestResult {
  return {
    record: {
      id: 'og_1',
      project: PROJECT,
      startedAt: 1,
      finishedAt: 2001,
      durationMs: 2000,
      engine: { version: '1.30.0', source: 'managed' },
      packIds: ['qodana-mit'],
      rulePaths: ['qodana-mit'],
      targets: ['.'],
      exitCode: 0,
      findings: 5,
      bySeverity: { ERROR: 1, WARNING: 2, INFO: 2 },
      scannedFiles: 40,
      errors: 0,
      partiallyParsed: 0,
      jsonFile: 'x.json',
    },
    digest: {
      version: '1.30.0',
      scannedFiles: 40,
      total: 5,
      shown: 3,
      bySeverity: { ERROR: 1, WARNING: 2, INFO: 0 },
      dropped: { belowFloor: 2, ignoredRules: 0, ignoredFingerprints: 0, duplicates: 0 },
      groups: [
        { ruleId: 'a', severity: 'ERROR', message: '', cwe: [], references: [], count: 1, files: [] },
        { ruleId: 'b', severity: 'WARNING', message: '', cwe: [], references: [], count: 2, files: [] },
      ],
      errors: [],
      partiallyParsed: [],
      skippedRules: 0,
      ...overrides,
    },
    markdown: '# Opengrep findings for this workflow step\n\n**3 findings shown**\n',
    config: {
      packIds: ['qodana-mit'],
      extraRulePaths: [],
      excludeGlobs: [],
      filter: { severityFloor: 'WARNING', ignoreRuleIds: [], ignoreFingerprints: [] },
      budgetBytes: 60 * 1024,
    },
  };
}

test('normalizeStepTools keeps known ids only, deduplicated, and stays absent when empty', () => {
  assert.deepEqual(normalizeStepTools(['opengrep', 'opengrep', 'bogus', 7]), ['opengrep']);
  assert.equal(normalizeStepTools(['bogus']), undefined);
  assert.equal(normalizeStepTools([]), undefined);
  assert.equal(normalizeStepTools('opengrep'), undefined);
  assert.equal(normalizeStepTools(undefined), undefined);
});

test('an opengrep step writes OPENGREP_FINDINGS.md into the step dir and the brief points at it', async () => {
  await withTempDir('lattice-step-tools-', async (dir) => {
    const seen: string[] = [];
    const { reports, markdown } = await runStepTools({ tools: ['opengrep'], kind: 'agent' }, PROJECT, dir, {
      scan: async (project) => {
        seen.push(project);
        return fakeResult();
      },
    });
    assert.deepEqual(seen, [PROJECT]);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].ok, true);
    assert.equal(reports[0].file, path.join(dir, OPENGREP_REPORT_FILENAME));
    const written = await fs.readFile(path.join(dir, OPENGREP_REPORT_FILENAME), 'utf8');
    assert.match(written, /3 findings shown/);
    assert.match(markdown, /^## Tool reports/);
    assert.match(markdown, /OPENGREP_FINDINGS\.md/);
    assert.match(markdown, /\*\*3 findings\*\* across 2 rules/);
    assert.match(markdown, /1 ERROR, 2 WARNING, 0 INFO/);
    assert.match(markdown, /opengrep:<fp>/);
  });
});

test('a step with no tools (or a control step) contributes nothing', async () => {
  await withTempDir('lattice-step-tools-', async (dir) => {
    let called = 0;
    const scan = async () => {
      called += 1;
      return fakeResult();
    };
    assert.deepEqual(await runStepTools({ kind: 'agent' }, PROJECT, dir, { scan }), { reports: [], markdown: '' });
    assert.deepEqual(await runStepTools({ tools: ['opengrep'], kind: 'start' }, PROJECT, dir, { scan }), {
      reports: [],
      markdown: '',
    });
    assert.equal(called, 0);
    await assert.rejects(fs.access(path.join(dir, OPENGREP_REPORT_FILENAME)));
  });
});

test('a run cancelled mid-scan aborts the pre-run through beginStepPreRun/abortStepPreRun and the brief says so', async () => {
  await withTempDir('lattice-step-tools-', async (dir) => {
    const signal = beginStepPreRun('run-1');
    assert.equal(signal.aborted, false);
    // The fake scan behaves like the real one: it rejects with the aborted
    // error once the caller's signal fires.
    const pending = runStepTools({ tools: ['opengrep'], kind: 'agent' }, PROJECT, dir, {
      scan: async (_project, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new OpengrepScanAbortedError()), { once: true });
        }),
    }, signal);
    assert.equal(abortStepPreRun('run-1'), true, 'cancel finds the in-flight pre-run');
    assert.equal(signal.aborted, true);
    const { reports, markdown } = await pending;
    endStepPreRun('run-1');
    assert.equal(reports[0].ok, false);
    assert.match(markdown, /cancelled while the scan was running/);
    assert.equal(abortStepPreRun('run-1'), false, 'nothing left to abort once it ended');
    await assert.rejects(fs.access(path.join(dir, OPENGREP_REPORT_FILENAME)));
  });
});

test('a tool that cannot run explains itself in the brief and the step still proceeds', async () => {
  await withTempDir('lattice-step-tools-', async (dir) => {
    for (const [err, expect] of [
      [new OpengrepNotInstalledError(), /not installed.*Settings → Tools/],
      [new OpengrepScanBusyError(PROJECT), /already running/],
      [new Error('kaboom'), /The scan failed: kaboom/],
    ] as const) {
      const { reports, markdown } = await runStepTools({ tools: ['opengrep'], kind: 'agent' }, PROJECT, dir, {
        scan: async () => {
          throw err;
        },
      });
      assert.equal(reports[0].ok, false);
      assert.equal(reports[0].file, undefined);
      assert.match(markdown, /no report this run/);
      assert.match(markdown, expect);
      assert.match(markdown, /Proceed with the step without it/);
    }
    await assert.rejects(fs.access(path.join(dir, OPENGREP_REPORT_FILENAME)));
  });
});

test('renderStepMarkdown places the tool reports under the step prompt, and omits the section without tools', () => {
  const wf: Workflow = {
    id: 'wf_1',
    name: 'w',
    projectPath: PROJECT,
    steps: [
      { id: 's1', title: 'Triage', prompt: 'THE PROMPT', mode: 'sequential', harness: 'claude', kind: 'agent', tools: ['opengrep'] },
    ],
    variables: [{ id: 'v', name: 'user_instructions', value: '' }],
    createdAt: 1,
  };
  const run = {
    id: 'wfrun_1',
    workflowId: 'wf_1',
    workflowName: 'w',
    projectPath: PROJECT,
    status: 'running',
    startedAt: 1,
    totalSteps: 1,
    currentStepIndex: 0,
  } as unknown as WorkflowRun;
  assert.ok(DEFAULT_WORKFLOW_STEP_TEMPLATE.includes('{{tool_reports}}'), 'the template carries the token');

  const withTools = renderStepMarkdown(wf, run, 0, 'http://127.0.0.1:5184', null, undefined, '## Tool reports\n\nREPORT BODY\n');
  const promptAt = withTools.indexOf('THE PROMPT');
  const reportAt = withTools.indexOf('## Tool reports');
  const projectAt = withTools.indexOf('## Active project');
  assert.ok(promptAt > 0 && reportAt > promptAt && projectAt > reportAt, 'prompt → tool reports → active project');
  assert.match(withTools, /REPORT BODY\n\n## Active project/);

  const without = renderStepMarkdown(wf, run, 0, 'http://127.0.0.1:5184');
  assert.ok(!without.includes('Tool reports'));
  assert.ok(!without.includes('{{tool_reports}}'), 'the token never leaks');
  assert.match(without, /THE PROMPT\n\n## Active project/);
});

test('a superseded pre-run ending does not orphan the newer pre-run from cancel', () => {
  const older = beginStepPreRun('run-supersede');
  const newer = beginStepPreRun('run-supersede');
  assert.equal(older.aborted, true, 'the newer begin aborts the older scan');
  // The older spawn unwinds after the newer one began.
  endStepPreRun('run-supersede', older);
  assert.equal(abortStepPreRun('run-supersede'), true, 'cancel still reaches the newer scan');
  assert.equal(newer.aborted, true);
  endStepPreRun('run-supersede', newer);
});
