// Second opinion is opt-in, bounded and strict: malformed settings or model
// output must never accidentally enable a rerun or classify a patch as accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getUserSettings, patchUserSettings, taskReviewIn, userSettingsShapeError, type UserSettings } from '../userSettings.js';
import { parseReviewReply, renderReviewPrompt, isReviewTestFile } from '../taskReview/prompt.js';
import { createReviewQueue } from '../taskReview/queue.js';
import { withTempDir } from './helpers/tempDir.js';

test('review settings validate enum/string shapes and heal malformed stored fields', async () => {
  const settings: UserSettings = {
    taskReview: 'rerun', taskReviewHarness: 'claude', taskReviewModel: 'claude-sonnet-5-5', taskReviewEffort: 'low',
    taskReviewRerunHarness: 'pi', taskReviewRerunPiModel: 'local/strong', taskReviewRerunModel: 'opus', taskReviewRerunEffort: 'high',
  };
  assert.equal(userSettingsShapeError(settings), null);
  assert.equal(taskReviewIn({}), 'off');
  for (const mode of ['off', 'flag', 'rerun'] as const) assert.equal(taskReviewIn({ taskReview: mode }), mode);
  for (const field of Object.keys(settings)) {
    assert.match(userSettingsShapeError({ [field]: 42 })!, new RegExp(field));
  }
  for (const [field, value] of Object.entries({ taskReview: 'yes', taskReviewHarness: 'pi',
    taskReviewRerunHarness: 'interleave', taskReviewEffort: 'turbo', taskReviewRerunEffort: '' })) {
    assert.match(userSettingsShapeError({ [field]: value })!, new RegExp(field));
  }
  await withTempDir('review-settings-', async (project) => {
    await patchUserSettings(project, settings);
    assert.deepEqual(await getUserSettings(project), settings);
    await fs.writeFile(path.join(project, '.lattice/userSettings.json'), JSON.stringify(
      Object.fromEntries(Object.keys(settings).map((key) => [key, 42])),
    ));
    const healed = await getUserSettings(project);
    for (const field of Object.keys(settings)) assert.equal(healed[field as keyof UserSettings], undefined);
    assert.equal(taskReviewIn(healed), 'off');
    // Optional fields clear through JSON null, just like sibling strings.
    assert.equal(userSettingsShapeError({ taskReviewRerunEffort: null, taskReviewModel: null }), null);
    await patchUserSettings(project, { taskReviewRerunEffort: null } as unknown as Partial<UserSettings>);
    assert.equal((await getUserSettings(project)).taskReviewRerunEffort, undefined);
  });
});

test('review prompt has exact instructions, source-first hunks and pre-change source only', () => {
  const prompt = renderReviewPrompt('Fix it', 'Handle missing keys.', [
    { path: 'a.test.ts', diff: 'TEST DIFF', before: 'hidden test', test: true },
    { path: 'a.ts', diff: 'SOURCE DIFF', before: 'old code', test: false },
    { path: 'new.ts', diff: 'NEW DIFF', before: '(new file)', test: false },
  ]);
  assert.equal(prompt, `You review a coding agent's change before it is merged. You cannot run anything.

TASK the agent was given:
Fix it

Handle missing keys.

AGENT PATCH:
SOURCE DIFF
NEW DIFF
TEST DIFF

PRE-PATCH SOURCE of the files it touched:
a.ts:
old code

new.ts:
(new file)

Predict whether this patch fully resolves the task: would regression tests that a maintainer writes for this task pass? Consider missed cases, wrong layer, partial fixes, and behavior the task implies but the patch ignores.
Answer ONLY JSON: {"p": <0-100 probability the patch is correct and complete>, "verdict": "accept" | "reject", "reason": "<= 20 words"}`);
  const bounded = renderReviewPrompt('Title', '', [
    { path: 'a.test.ts', diff: 'T'.repeat(20_000), before: 'never', test: true },
    { path: 'a.ts', diff: 'S'.repeat(20_000), before: 'B'.repeat(20_000), test: false },
  ]);
  const patch = bounded.split('AGENT PATCH:\n')[1].split('\n\nPRE-PATCH SOURCE')[0];
  const source = bounded.split('PRE-PATCH SOURCE of the files it touched:\n')[1].split('\n\nPredict whether')[0];
  assert.equal(patch, 'S'.repeat(12_000));
  assert.equal(source.length, 14_000);
  assert.ok(!bounded.includes('never'));
  for (const file of ['src/__tests__/a.ts', 'test/a.py', 'foo.spec.tsx', 'foo_test.go', 'e2e/foo.ts']) assert.equal(isReviewTestFile(file), true);
  assert.equal(isReviewTestFile('src/testable.ts'), false);
});

test('review parser accepts first balanced JSON object and rejects malformed or incomplete responses', () => {
  assert.deepEqual(parseReviewReply('```json\n{"p":97,"verdict":"accept","reason":"Handles {all} cases"}\n```'),
    { p: 97, verdict: 'accept', reason: 'Handles {all} cases' });
  assert.deepEqual(parseReviewReply('{"p":0,"verdict":"reject","reason":"Missing edge case"} trailing {}'),
    { p: 0, verdict: 'reject', reason: 'Missing edge case' });
  for (const value of ['', 'not json', '{', '{}', '{"p":90,"verdict":"yes","reason":"x"}',
    '{"p":"90","verdict":"accept","reason":"x"}', '{"p":101,"verdict":"accept","reason":"x"}',
    '{"p":-1,"verdict":"reject","reason":"x"}', '{"p":90,"verdict":"accept"}',
    '{"p":90,"reason":"x"}', '{"p":90,"verdict":"accept","reason":null}',
    '{} {"p":90,"verdict":"accept","reason":"x"}']) assert.equal(parseReviewReply(value), null, value);
  assert.equal(parseReviewReply(JSON.stringify({ p: 100, verdict: 'accept', reason: 'x'.repeat(400) }))?.reason.length, 300);
});

test('review FIFO never has more than four in flight and deduplicates jobs', async () => {
  const queue = createReviewQueue();
  const started: number[] = [];
  const finish: (() => void)[] = [];
  for (let i = 0; i < 7; i++) queue.enqueue(String(i), () => new Promise<void>((resolve) => { started.push(i); finish[i] = resolve; }));
  assert.equal(queue.enqueue('0', async () => { assert.fail('duplicate ran'); }), false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.equal(queue.active, 4);
  finish[0]();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  finish[1](); finish[2](); finish[3](); finish[4]();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6]);
  finish[5](); finish[6]();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(queue.size, 0);
  assert.equal(queue.active, 0);
});

test('a newer head queued during worker settlement cannot lose its wake-up', async () => {
  const queue = createReviewQueue(1);
  let finish!: () => void;
  const events: string[] = [];
  queue.enqueue('task', async () => {
    await new Promise<void>((resolve) => { finish = resolve; });
    events.push('old');
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  queue.enqueue('task', async () => { events.push('new'); }, { reschedule: true });
  finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['old', 'new']);
  assert.equal(queue.size, 0);
});
