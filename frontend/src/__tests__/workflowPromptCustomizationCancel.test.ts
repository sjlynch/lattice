import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React, { type SetStateAction } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { WorkflowPromptCustomization, WorkflowStep } from '../api';
import type { EditorState } from '../components/workflows/editorState.ts';
import type { Ctx } from '../terminal/terminalTypes.ts';
import {
  pollPromptCustomization,
  useWorkflowPromptCustomization,
  WORKFLOW_PROMPT_CUSTOMIZATION_POLL_INTERVAL_MS,
} from '../components/workflows/hooks/useWorkflowPromptCustomization.ts';

// Regression: the prompt-customization poll loop used to be a detached,
// un-cancellable ~6-minute fire-and-forget async loop. If the Workflows panel
// unmounted or the user switched projects mid-customization it kept polling and
// then called setEditor / setCustomizingSteps / showError regardless of the now-
// active project — patching the wrong workflow's step and toasting against the
// wrong project (plus React setState-after-unmount warnings).
//
// Two layers of coverage: the extracted pure `pollPromptCustomization` (its
// `isCancelled` gate) and the real hook driven headlessly across an unmount and
// a project switch.

// ---- pure poll-loop gating -------------------------------------------------

function customization(
  over: Partial<WorkflowPromptCustomization>,
): WorkflowPromptCustomization {
  return {
    id: 'req1',
    projectPath: 'C:/A',
    stepTitle: 'Step 1',
    originalPrompt: '',
    harness: 'claude',
    status: 'running',
    createdAt: 0,
    command: 'run',
    cwd: 'C:/cwd',
    ...over,
  } as WorkflowPromptCustomization;
}

type PollCalls = {
  completed: string[];
  errors: string[];
  exhausted: number;
  settled: number;
  statusReads: number;
};

function pollWith(opts: {
  isCancelled: () => boolean;
  status: () => Promise<WorkflowPromptCustomization>;
}) {
  const calls: PollCalls = {
    completed: [],
    errors: [],
    exhausted: 0,
    settled: 0,
    statusReads: 0,
  };
  const run = pollPromptCustomization('req1', {
    getStatus: async (id) => {
      calls.statusReads += 1;
      assert.equal(id, 'req1');
      return opts.status();
    },
    sleep: async () => {},
    isCancelled: opts.isCancelled,
    onCompleted: (p) => calls.completed.push(p),
    onError: (m) => calls.errors.push(m),
    onExhausted: () => {
      calls.exhausted += 1;
    },
    onSettled: () => {
      calls.settled += 1;
    },
  });
  return { calls, run };
}

test('a cancelled session drops a completed result but still settles', async () => {
  const { calls, run } = pollWith({
    isCancelled: () => true,
    status: async () => customization({ status: 'completed', resultPrompt: 'NEW' }),
  });
  await run;
  // isCancelled is checked immediately after the first sleep, before the status
  // fetch even runs — so nothing is read and no result is applied.
  assert.equal(calls.statusReads, 0, 'must not poll a cancelled session');
  assert.deepEqual(calls.completed, [], 'must not patch the editor when cancelled');
  assert.deepEqual(calls.errors, [], 'must not toast when cancelled');
  assert.equal(calls.exhausted, 0);
  assert.equal(calls.settled, 1, 'the spinner cleanup still runs');
});

test('a live session applies a completed result', async () => {
  const { calls, run } = pollWith({
    isCancelled: () => false,
    status: async () => customization({ status: 'completed', resultPrompt: 'REVISED' }),
  });
  await run;
  assert.deepEqual(calls.completed, ['REVISED']);
  assert.deepEqual(calls.errors, []);
  assert.equal(calls.settled, 1);
});

test('an errored status surfaces the backend error message', async () => {
  const { calls, run } = pollWith({
    isCancelled: () => false,
    status: async () => customization({ status: 'errored', error: 'boom' }),
  });
  await run;
  assert.deepEqual(calls.errors, ['Prompt customization failed: boom']);
  assert.deepEqual(calls.completed, []);
  assert.equal(calls.settled, 1);
});

test('a thrown poll on a live session toasts, but a cancelled one stays silent', async () => {
  const thrown = pollWith({
    isCancelled: () => false,
    status: async () => {
      throw new Error('network down');
    },
  });
  await thrown.run;
  assert.deepEqual(thrown.calls.errors, [
    'Prompt customization polling failed: network down',
  ]);
  assert.equal(thrown.calls.settled, 1);

  // Same throw, but the session cancelled after the fetch was issued: the error
  // is swallowed (no cross-project toast) yet cleanup still runs.
  let cancelled = false;
  const quiet = pollWith({
    isCancelled: () => cancelled,
    status: async () => {
      cancelled = true;
      throw new Error('network down');
    },
  });
  await quiet.run;
  assert.deepEqual(quiet.calls.errors, [], 'a cancelled session swallows the throw');
  assert.equal(quiet.calls.settled, 1);
});

// ---- the real hook across unmount / project switch -------------------------

type Api = ReturnType<typeof useWorkflowPromptCustomization>;

let latestApi: Api;
let setEditorCalls: Array<(cur: EditorState) => EditorState> = [];
let showErrorCalls: string[] = [];
let addTerminalCalls = 0;

function makeStep(): WorkflowStep {
  return {
    id: 'step_srv_1',
    title: 'Step 1',
    prompt: '', // empty => window.prompt path (no template inference)
    harness: 'claude',
    kind: 'agent',
  };
}

const STEPS = [makeStep()];

const addTerminal: Ctx['addTerminal'] = () => {
  addTerminalCalls += 1;
  return 'term-1';
};

function Harness({ folder }: { folder: string }) {
  latestApi = useWorkflowPromptCustomization({
    activeFolder: folder,
    steps: STEPS,
    setEditor: (value: SetStateAction<EditorState>) => {
      if (typeof value === 'function') {
        setEditorCalls.push(value as (cur: EditorState) => EditorState);
      }
    },
    addTerminal,
    showError: (m: string) => showErrorCalls.push(m),
  });
  return null;
}

// A `setTimeout` that captures the poll loop's 2s sleep so the test fires it on
// demand, while any other timer (React's own scheduling) uses the real clock.
let capturedSleep: (() => void) | null = null;
let realSetTimeout: typeof setTimeout;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 15; i += 1) await Promise.resolve();
  });
}

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;

beforeEach(() => {
  saved = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    fetch: g.fetch,
    window: g.window,
    setTimeout: g.setTimeout,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  latestApi = undefined as unknown as Api;
  setEditorCalls = [];
  showErrorCalls = [];
  addTerminalCalls = 0;
  capturedSleep = null;
  realSetTimeout = setTimeout;

  g.setTimeout = ((cb: () => void, delay?: number, ...rest: unknown[]) => {
    if (delay === WORKFLOW_PROMPT_CUSTOMIZATION_POLL_INTERVAL_MS) {
      capturedSleep = cb;
      return { __captured: true } as unknown as ReturnType<typeof setTimeout>;
    }
    return (realSetTimeout as (...a: unknown[]) => unknown)(cb, delay, ...rest);
  }) as unknown as typeof setTimeout;

  g.window = { prompt: () => 'tailor it' };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

/** Route the two customization calls; the GET status is scriptable per test. */
function installFetch(status: () => WorkflowPromptCustomization) {
  let getReads = 0;
  const startResponse = customization({ id: 'req1', serverId: 'srv1' });
  g.fetch = ((url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url === '/api/workflow-prompt-customizations') {
      return Promise.resolve({ ok: true, json: async () => startResponse });
    }
    if (
      method === 'GET' &&
      url.startsWith('/api/workflow-prompt-customizations/')
    ) {
      getReads += 1;
      return Promise.resolve({ ok: true, json: async () => status() });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  }) as unknown as typeof fetch;
  return { getReads: () => getReads };
}

async function mountAndStart(folder: string) {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(Harness, { folder }),
    );
  });
  await act(async () => {
    void latestApi.customizeStepPrompt(0);
    for (let i = 0; i < 15; i += 1) await Promise.resolve();
  });
  return renderer;
}

test('unmounting the hook stops the poll: no setEditor/showError after unmount', async () => {
  const fetchState = installFetch(() =>
    customization({ status: 'completed', resultPrompt: 'REVISED' }),
  );

  const renderer = await mountAndStart('C:/project-A');
  assert.ok(capturedSleep, 'the poll loop should have scheduled its first sleep');
  assert.equal(addTerminalCalls, 1, 'the customization terminal spawns immediately');

  // Unmount before the poll resolves — the session is cancelled.
  act(() => {
    renderer.unmount();
  });

  // Now let the pending sleep resolve; the loop must bail before fetching.
  const fire = capturedSleep!;
  capturedSleep = null;
  await act(async () => {
    fire();
    for (let i = 0; i < 15; i += 1) await Promise.resolve();
  });

  assert.equal(fetchState.getReads(), 0, 'a cancelled poll never re-reads status');
  assert.deepEqual(setEditorCalls, [], 'no editor patch after unmount');
  assert.deepEqual(showErrorCalls, [], 'no toast after unmount');
});

test('switching projects mid-customization does not patch/toast the new project', async () => {
  const fetchState = installFetch(() =>
    customization({ status: 'completed', resultPrompt: 'REVISED' }),
  );

  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(Harness, { folder: 'C:/project-A' }),
    );
  });
  await act(async () => {
    void latestApi.customizeStepPrompt(0);
    for (let i = 0; i < 15; i += 1) await Promise.resolve();
  });
  assert.ok(capturedSleep, 'poll scheduled');

  // Switch the active project to B before the poll resolves.
  await act(async () => {
    renderer.update(React.createElement(Harness, { folder: 'C:/project-B' }));
  });

  const fire = capturedSleep!;
  capturedSleep = null;
  await act(async () => {
    fire();
    for (let i = 0; i < 15; i += 1) await Promise.resolve();
  });

  assert.equal(fetchState.getReads(), 0, 'a project-A poll must not keep polling on B');
  assert.deepEqual(setEditorCalls, [], 'project A customization must not patch project B');
  assert.deepEqual(showErrorCalls, [], 'project A customization must not toast project B');

  act(() => {
    renderer.unmount();
  });
});

test('a customization that completes while still mounted patches the edited step', async () => {
  installFetch(() =>
    customization({ status: 'completed', resultPrompt: 'REVISED' }),
  );

  const renderer = await mountAndStart('C:/project-A');
  assert.ok(capturedSleep, 'poll scheduled');

  const fire = capturedSleep!;
  capturedSleep = null;
  await act(async () => {
    fire();
    for (let i = 0; i < 15; i += 1) await Promise.resolve();
  });
  await flush();

  assert.equal(showErrorCalls.length, 0, 'a clean completion emits no error');
  assert.equal(setEditorCalls.length, 1, 'the editor is patched once');

  // The updater patches the matching step by id and marks the editor dirty.
  const editor: EditorState = {
    workflowId: null,
    name: 'W',
    steps: [{ ...makeStep(), prompt: 'OLD' }],
    variables: [],
    dirty: false,
  };
  const next = setEditorCalls[0](editor);
  assert.equal(next.steps[0].prompt, 'REVISED', 'the step prompt is replaced');
  assert.equal(next.dirty, true, 'the editor is marked dirty');

  act(() => {
    renderer.unmount();
  });
});
