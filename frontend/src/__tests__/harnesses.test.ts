import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableHarnessChoices,
  buildHarnessOptions,
  decodeHarnessValue,
  encodeHarnessValue,
  isValidPiModel,
  selectedOptionTitle,
} from '../harnesses.ts';
import type {
  HarnessAvailability,
  HarnessChoice,
  HarnessOption,
  HarnessSelection,
  PiModelMenuEntry,
} from '../harnesses.ts';

// `harnesses.ts` is the single encode/decode source of truth behind every
// harness dropdown (taskboard filters, workflow steps, workflow run overrides,
// post-merge hook, sidebar new-terminal tray). A regression here silently drops
// a harness/model row from ALL of them, or lets an unsafe model token reach a
// spawned command line.

const NONE: HarnessAvailability = { claude: true, pi: false, codex: false };
const ALL: HarnessAvailability = { claude: true, pi: true, codex: true };
const PI_ONLY: HarnessAvailability = { claude: true, pi: true, codex: false };
const CODEX_ONLY: HarnessAvailability = { claude: true, pi: false, codex: true };

// Mirrors the (unexported) PI_LABEL_MAX_CHARS in harnesses.ts, so the expected
// truncated labels below are COMPUTED with the same rule rather than
// hand-counted — the test therefore also documents the exact cap.
const PI_LABEL_MAX_CHARS = 28;
const truncated = (friendly: string) => `${friendly.slice(0, PI_LABEL_MAX_CHARS - 1)}…`;

const entry = (pattern: string, label?: string): PiModelMenuEntry => ({
  pattern,
  label: label ?? pattern,
});

const values = (options: HarnessOption[]) => options.map((o) => o.value);

const build = (args: {
  harnessAvail?: HarnessAvailability;
  piMenu?: PiModelMenuEntry[];
  selected?: HarnessSelection;
  includeInterleave?: boolean;
}) =>
  buildHarnessOptions({
    harnessAvail: args.harnessAvail ?? ALL,
    piMenu: args.piMenu ?? [],
    selected: args.selected ?? { harness: 'claude' },
    includeInterleave: args.includeInterleave ?? false,
  });

// ---------------------------------------------------------------------------
// isValidPiModel — the shell-injection guard
// ---------------------------------------------------------------------------

// A selected Pi model is interpolated straight into a command string
// (`pi --approve --model "<piModel>"` in components/sidebar/constants.ts, and
// `buildPiModelFlag` on the backend). PI_MODEL_RE mirrors the backend's
// PI_MODEL_PATTERN_RE (agentCommandBuilder.ts) and is what stops an arbitrary
// settings/localStorage value from becoming shell syntax.

test('isValidPiModel accepts provider/model and provider/model:thinking', () => {
  assert.equal(isValidPiModel('vllm/qwen'), true);
  assert.equal(isValidPiModel('qwen-local/qwen'), true);
  assert.equal(isValidPiModel('openai-codex/gpt-5.5'), true);
  assert.equal(isValidPiModel('qwen-local/qwen:thinking'), true);
  // The safe charset is [A-Za-z0-9_.-] on both sides of the slash.
  assert.equal(isValidPiModel('vllm_endpoint-2/Qwen3-Coder.480B_A35B:thinking'), true);
});

test('isValidPiModel rejects shell metacharacters and injection payloads', () => {
  // These mirror the backend normalizePiModel corpus (piModels.test.ts) — the
  // two guards must reject the same things or the frontend hands the backend a
  // token it will silently drop (or, worse, one the sidebar interpolates).
  const payloads = [
    'vllm/qwen"; rm -rf /', // closes the double quote in `--model "<x>"`
    'a/b && curl evil',
    'a/b; whoami',
    'a/b | tee /tmp/x',
    'a/b$(whoami)',
    'a/b`id`',
    'a/b\nrm -rf /',
    'a/b > out',
    "a/b'",
    'a/b\\c',
    'a/b*',
    'vllm/qwen thinking', // a space is never valid
  ];
  for (const payload of payloads) {
    assert.equal(isValidPiModel(payload), false, `must reject ${JSON.stringify(payload)}`);
  }
});

test('isValidPiModel rejects malformed provider/model shapes', () => {
  assert.equal(isValidPiModel('qwen'), false, 'no provider segment');
  assert.equal(isValidPiModel('/qwen'), false, 'empty provider');
  assert.equal(isValidPiModel('vllm/'), false, 'empty model');
  assert.equal(isValidPiModel('a/b/c'), false, 'only one slash is allowed');
  assert.equal(isValidPiModel('a/b:'), false, 'empty thinking suffix');
  assert.equal(isValidPiModel('a/b:x:y'), false, 'only one thinking suffix');
  assert.equal(isValidPiModel(''), false);
  assert.equal(isValidPiModel(undefined), false);
});

test('isValidPiModel does NOT trim — unlike the backend normalizePiModel', () => {
  // Deliberate divergence: the frontend value always arrives from an encoded
  // `<select>` option (never free text), so a padded token means something
  // upstream is malformed rather than merely untidy. Pinned so a future "let's
  // be lenient and trim" edit is a conscious choice, not an accident.
  assert.equal(isValidPiModel('  vllm/qwen  '), false);
  assert.equal(isValidPiModel('vllm/qwen '), false);
});

// ---------------------------------------------------------------------------
// encodeHarnessValue / decodeHarnessValue
// ---------------------------------------------------------------------------

test('encodeHarnessValue only prefixes for pi + a model, and is the bare harness otherwise', () => {
  assert.equal(encodeHarnessValue('pi', 'vllm/qwen'), 'pi:vllm/qwen');
  assert.equal(encodeHarnessValue('pi'), 'pi');
  assert.equal(encodeHarnessValue('pi', ''), 'pi', 'an empty model is not a selection');
  assert.equal(encodeHarnessValue('claude'), 'claude');
  assert.equal(encodeHarnessValue('codex'), 'codex');
  assert.equal(encodeHarnessValue('interleave'), 'interleave');
  // A stale piModel left over from a previous pi selection must not leak into a
  // non-pi harness value.
  assert.equal(encodeHarnessValue('claude', 'vllm/qwen'), 'claude');
  assert.equal(encodeHarnessValue('codex', 'vllm/qwen'), 'codex');
  assert.equal(encodeHarnessValue('interleave', 'vllm/qwen'), 'interleave');
});

test('decodeHarnessValue splits pi:<model> and passes plain harnesses through', () => {
  assert.deepEqual(decodeHarnessValue('pi:vllm/qwen'), { harness: 'pi', piModel: 'vllm/qwen' });
  // Only the leading `pi:` is stripped — a `:thinking` suffix stays part of the
  // model id.
  assert.deepEqual(decodeHarnessValue('pi:vllm/qwen:thinking'), {
    harness: 'pi',
    piModel: 'vllm/qwen:thinking',
  });
  assert.deepEqual(decodeHarnessValue('claude'), { harness: 'claude' });
  assert.deepEqual(decodeHarnessValue('codex'), { harness: 'codex' });
  assert.deepEqual(decodeHarnessValue('pi'), { harness: 'pi' });
  assert.deepEqual(decodeHarnessValue('interleave'), { harness: 'interleave' });
});

test('decodeHarnessValue("pi:") is bare pi with NO piModel key', () => {
  const decoded = decodeHarnessValue('pi:');
  // deepEqual (strict) already fails on a `piModel: undefined` own key, but the
  // `in` check states the contract outright: callers spread this over settings,
  // so an explicit `undefined` would clobber a stored model rather than mean
  // "no model chosen".
  assert.deepEqual(decoded, { harness: 'pi' });
  assert.equal('piModel' in decoded, false);
});

test('decodeHarnessValue falls back to claude for anything unrecognised', () => {
  assert.deepEqual(decodeHarnessValue('gpt'), { harness: 'claude' });
  assert.deepEqual(decodeHarnessValue(''), { harness: 'claude' });
  assert.deepEqual(decodeHarnessValue('PI'), { harness: 'claude' }, 'case-sensitive');
});

test('decodeHarnessValue does not validate the model — isValidPiModel is the guard', () => {
  // Decoding is pure transport. The injection guard lives at the point of use
  // (sidebar command building / the backend flag builder), so an unsafe value
  // round-trips here but never passes isValidPiModel.
  const unsafe = 'a/b && curl evil';
  const decoded = decodeHarnessValue(`pi:${unsafe}`);
  assert.deepEqual(decoded, { harness: 'pi', piModel: unsafe });
  assert.equal(isValidPiModel(decoded.piModel), false);
});

test('encode → decode round-trips every selection shape', () => {
  const selections: HarnessSelection[] = [
    { harness: 'claude' },
    { harness: 'codex' },
    { harness: 'pi' },
    { harness: 'interleave' },
    { harness: 'pi', piModel: 'vllm/qwen' },
    { harness: 'pi', piModel: 'qwen-local/qwen:thinking' },
    { harness: 'pi', piModel: 'openai-codex/gpt-5.5' },
  ];
  for (const sel of selections) {
    assert.deepEqual(
      decodeHarnessValue(encodeHarnessValue(sel.harness, sel.piModel)),
      sel,
      `round-trip of ${JSON.stringify(sel)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// availableHarnessChoices
// ---------------------------------------------------------------------------

test('availableHarnessChoices gates pi/codex/interleave on detected CLIs', () => {
  assert.deepEqual(availableHarnessChoices(NONE), ['claude']);
  assert.deepEqual(availableHarnessChoices(CODEX_ONLY), ['claude', 'codex']);
  // Interleave round-robins through pi, so it rides on pi's availability.
  assert.deepEqual(availableHarnessChoices(PI_ONLY), ['claude', 'pi', 'interleave']);
  assert.deepEqual(availableHarnessChoices(ALL), ['claude', 'pi', 'codex', 'interleave']);
});

test('availableHarnessChoices keeps an already-selected but unavailable choice', () => {
  // A saved choice must never silently vanish from its own dropdown.
  for (const selected of ['pi', 'codex', 'interleave'] as HarnessChoice[]) {
    assert.ok(
      availableHarnessChoices(NONE, selected).includes(selected),
      `${selected} must stay listed when selected`,
    );
  }
  // ...but selecting `pi` does not also resurrect the interleave row.
  assert.deepEqual(availableHarnessChoices(NONE, 'pi'), ['claude', 'pi']);
  assert.deepEqual(availableHarnessChoices(NONE, 'interleave'), ['claude', 'interleave']);
  assert.deepEqual(availableHarnessChoices(NONE, 'claude'), ['claude']);
});

// ---------------------------------------------------------------------------
// buildHarnessOptions — visibility gating
// ---------------------------------------------------------------------------

test('buildHarnessOptions lists claude, then codex, then pi (+models), then interleave', () => {
  const options = build({
    harnessAvail: ALL,
    piMenu: [entry('vllm/qwen', 'Qwen'), entry('openai-codex/gpt-5.5', 'GPT 5.5')],
    includeInterleave: true,
  });
  assert.deepEqual(values(options), [
    'claude',
    'codex',
    'pi',
    'pi:vllm/qwen',
    'pi:openai-codex/gpt-5.5',
    'interleave',
  ]);
  assert.deepEqual(
    options.map((o) => o.label),
    ['Claude', 'Codex', 'Pi', 'Pi — Qwen', 'Pi — GPT 5.5', 'Interleave'],
  );
});

test('buildHarnessOptions offers claude alone when nothing else is detected', () => {
  const options = build({
    harnessAvail: NONE,
    piMenu: [entry('vllm/qwen', 'Qwen')],
    includeInterleave: true,
  });
  // No pi ⇒ no "Pi — X" rows even though a menu was supplied, and no interleave.
  assert.deepEqual(values(options), ['claude']);
});

test('buildHarnessOptions keeps a selected-but-unavailable pi/codex row visible', () => {
  assert.deepEqual(
    values(build({ harnessAvail: NONE, selected: { harness: 'codex' } })),
    ['claude', 'codex'],
  );
  const piSelected = build({
    harnessAvail: NONE,
    piMenu: [entry('vllm/qwen', 'Qwen')],
    selected: { harness: 'pi' },
    includeInterleave: true,
  });
  // Pi and its curated models reappear because pi is the current selection —
  // but interleave still needs a real pi install.
  assert.deepEqual(values(piSelected), ['claude', 'pi', 'pi:vllm/qwen']);
});

test('buildHarnessOptions gates interleave on includeInterleave AND (pi || selected)', () => {
  // includeInterleave is false for the non-taskboard selectors (workflow steps,
  // post-merge hook) — pi availability alone must not add the row.
  assert.equal(
    values(build({ harnessAvail: ALL, includeInterleave: false })).includes('interleave'),
    false,
  );
  assert.equal(
    values(build({ harnessAvail: ALL, includeInterleave: true })).includes('interleave'),
    true,
  );
  // Pi went missing but interleave is the saved choice: keep it selectable.
  assert.deepEqual(
    values(build({ harnessAvail: NONE, selected: { harness: 'interleave' }, includeInterleave: true })),
    ['claude', 'interleave'],
  );
  assert.equal(
    values(build({ harnessAvail: NONE, selected: { harness: 'interleave' }, includeInterleave: false }))
      .includes('interleave'),
    false,
  );
});

// ---------------------------------------------------------------------------
// buildHarnessOptions — saved-but-uncurated Pi model
// ---------------------------------------------------------------------------

test('buildHarnessOptions appends a saved pi model that is not in the curated menu', () => {
  const options = build({
    harnessAvail: ALL,
    piMenu: [entry('vllm/qwen', 'Qwen')],
    selected: { harness: 'pi', piModel: 'custom-endpoint/mystery-13b' },
  });
  // Appended last, after the curated rows, so a stored choice is still
  // selectable (otherwise the <select> would show a blank/wrong value).
  assert.deepEqual(values(options), [
    'claude',
    'codex',
    'pi',
    'pi:vllm/qwen',
    'pi:custom-endpoint/mystery-13b',
  ]);
  const appended = options[options.length - 1];
  // No friendly name exists for it, so the label falls back to the model
  // segment of `provider/model`.
  assert.equal(appended.label, 'Pi — mystery-13b');
  assert.equal(appended.title, 'Pi — custom-endpoint/mystery-13b');
});

test('buildHarnessOptions does not duplicate a saved pi model already in the menu', () => {
  const options = build({
    harnessAvail: ALL,
    piMenu: [entry('vllm/qwen', 'Qwen'), entry('openai-codex/gpt-5.5', 'GPT 5.5')],
    selected: { harness: 'pi', piModel: 'vllm/qwen' },
  });
  assert.equal(
    values(options).filter((v) => v === 'pi:vllm/qwen').length,
    1,
    'the curated row is reused, not duplicated',
  );
  // ...and it keeps the curated friendly label rather than the raw pattern.
  assert.equal(options.find((o) => o.value === 'pi:vllm/qwen')?.label, 'Pi — Qwen');
});

test('buildHarnessOptions ignores a stale piModel when the harness is not pi', () => {
  const options = build({
    harnessAvail: ALL,
    piMenu: [entry('vllm/qwen', 'Qwen')],
    selected: { harness: 'claude', piModel: 'custom-endpoint/mystery-13b' },
  });
  assert.deepEqual(values(options), ['claude', 'codex', 'pi', 'pi:vllm/qwen']);
});

test('buildHarnessOptions does not mutate the caller-owned piMenu array', () => {
  // The menu comes from the shared piModelMenuStore cache — appending the saved
  // model in place would poison every other selector on the page.
  const piMenu = [entry('vllm/qwen', 'Qwen')];
  build({
    harnessAvail: ALL,
    piMenu,
    selected: { harness: 'pi', piModel: 'custom-endpoint/mystery-13b' },
  });
  assert.deepEqual(piMenu, [entry('vllm/qwen', 'Qwen')]);
});

// ---------------------------------------------------------------------------
// buildHarnessOptions — label truncation vs. the full-id title
// ---------------------------------------------------------------------------

test('buildHarnessOptions truncates a long friendly label but keeps the full id in title', () => {
  const friendly = 'Qwen3 Coder 480B A35B Instruct FP8'; // 34 chars
  assert.ok(friendly.length > PI_LABEL_MAX_CHARS);
  const options = build({
    harnessAvail: PI_ONLY,
    piMenu: [entry('vllm-endpoint/qwen3-coder-480b', friendly)],
  });
  const row = options[options.length - 1];
  assert.equal(row.label, `Pi — ${truncated(friendly)}`);
  assert.equal(row.label.replace('Pi — ', '').length, PI_LABEL_MAX_CHARS);
  assert.ok(row.label.endsWith('…'));
  // The tooltip carries the un-truncated `provider/model` id, so the closed
  // control can still reveal exactly what will run.
  assert.equal(row.title, 'Pi — vllm-endpoint/qwen3-coder-480b');
});

test('buildHarnessOptions leaves a label at exactly the cap untouched', () => {
  const exact = 'x'.repeat(PI_LABEL_MAX_CHARS);
  const over = 'y'.repeat(PI_LABEL_MAX_CHARS + 1);
  const options = build({
    harnessAvail: PI_ONLY,
    piMenu: [entry('vllm/a', exact), entry('vllm/b', over)],
  });
  assert.equal(options.find((o) => o.value === 'pi:vllm/a')?.label, `Pi — ${exact}`);
  assert.equal(options.find((o) => o.value === 'pi:vllm/b')?.label, `Pi — ${truncated(over)}`);
});

test('buildHarnessOptions falls back to the model segment when there is no friendly name', () => {
  const options = build({
    harnessAvail: PI_ONLY,
    piMenu: [
      // label === pattern (the store's fallback shape) — drop the provider
      // prefix and any `:thinking` suffix.
      entry('vllm-endpoint/qwen3-coder:thinking'),
      // A blank label takes the same path.
      entry('vllm/qwen', ''),
      // A long derived segment is truncated just like a friendly name.
      entry('vllm-endpoint/Qwen3-Coder-480B-A35B-Instruct-FP8:thinking'),
    ],
  });
  assert.deepEqual(
    options.filter((o) => o.value.startsWith('pi:')).map((o) => o.label),
    [
      'Pi — qwen3-coder',
      'Pi — qwen',
      `Pi — ${truncated('Qwen3-Coder-480B-A35B-Instruct-FP8')}`,
    ],
  );
  // Titles always hold the full pattern, suffix included.
  assert.deepEqual(
    options.filter((o) => o.value.startsWith('pi:')).map((o) => o.title),
    [
      'Pi — vllm-endpoint/qwen3-coder:thinking',
      'Pi — vllm/qwen',
      'Pi — vllm-endpoint/Qwen3-Coder-480B-A35B-Instruct-FP8:thinking',
    ],
  );
});

// ---------------------------------------------------------------------------
// The dropdown contract: options ⇄ encode/decode ⇄ the injection guard
// ---------------------------------------------------------------------------

test('every built option value decodes back to the selection it represents', () => {
  const piMenu = [entry('vllm/qwen', 'Qwen'), entry('qwen-local/qwen:thinking', 'Qwen (thinking)')];
  const options = build({
    harnessAvail: ALL,
    piMenu,
    selected: { harness: 'pi', piModel: 'custom-endpoint/mystery-13b' },
    includeInterleave: true,
  });
  for (const option of options) {
    const sel = decodeHarnessValue(option.value);
    assert.equal(
      encodeHarnessValue(sel.harness, sel.piModel),
      option.value,
      `${option.value} must survive decode → encode`,
    );
    // Every Pi row's model is safe to interpolate into a command line.
    if (sel.piModel) assert.equal(isValidPiModel(sel.piModel), true, sel.piModel);
  }
});

test('selectedOptionTitle prefers the full-id title, then the label, then empty', () => {
  const options = build({
    harnessAvail: PI_ONLY,
    piMenu: [entry('vllm-endpoint/qwen3-coder-480b', 'Qwen3 Coder 480B A35B Instruct FP8')],
  });
  // A truncated Pi row still reveals its full id on the closed control.
  assert.equal(
    selectedOptionTitle(options, 'pi:vllm-endpoint/qwen3-coder-480b'),
    'Pi — vllm-endpoint/qwen3-coder-480b',
  );
  // Plain harness rows carry no title — fall back to the visible label.
  assert.equal(selectedOptionTitle(options, 'claude'), 'Claude');
  assert.equal(selectedOptionTitle(options, 'codex'), '', 'unknown value has no tooltip');
});
