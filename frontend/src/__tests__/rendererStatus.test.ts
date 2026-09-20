import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeRendererFailure,
  isWebglUnavailableError,
  rendererErrorText,
} from '../components/forceGraph/rendererStatus.ts';

// The message THREE actually throws out of `new WebGLRenderer` when the
// browser hands back a null context — the failure the graph must survive
// (a spent per-page context budget, or a GPU process that died with the
// machine's memory). Verbatim from three's WebGLRenderer.
const THREE_MESSAGE = 'Error creating WebGL context.';

test('THREE’s context-creation throw is classified as WebGL-unavailable', () => {
  assert.equal(isWebglUnavailableError(new Error(THREE_MESSAGE)), true);
});

test('other WebGL phrasings are recognized too', () => {
  for (const message of [
    'WebGL is not supported',
    'WebGL unsupported in this browser',
    'WebGL context is unavailable',
    'WEBGL_lose_context: context disabled',
  ]) {
    assert.equal(isWebglUnavailableError(new Error(message)), true, message);
  }
});

test('an unrelated scene-setup fault is not a WebGL failure', () => {
  assert.equal(
    isWebglUnavailableError(new TypeError('graph.nodeThreeObject is not a function')),
    false,
  );
});

test('error text survives non-Error throws', () => {
  assert.equal(rendererErrorText(THREE_MESSAGE), THREE_MESSAGE);
  assert.equal(rendererErrorText(new Error(THREE_MESSAGE)), THREE_MESSAGE);
  // Empty / nullish throws still produce something renderable rather than ''.
  assert.equal(rendererErrorText(undefined), 'Unknown renderer error');
  assert.equal(rendererErrorText(new Error('')), 'Unknown renderer error');
});

test('describeRendererFailure carries the message and the WebGL flag', () => {
  assert.deepEqual(describeRendererFailure(new Error(THREE_MESSAGE)), {
    kind: 'unavailable',
    message: THREE_MESSAGE,
    webgl: true,
  });
  assert.deepEqual(describeRendererFailure(new Error('boom')), {
    kind: 'unavailable',
    message: 'boom',
    webgl: false,
  });
});
