import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { installCanvasDocument } from './domDoubles.ts';

// agentOverlayLabels.ts → labelTexture.ts builds its label textures from a real
// <canvas> (at module load and per label). Node's test runner has no DOM, so
// install the shared canvas/2d-context stub. It's installed BEFORE the dynamic
// import below so the module graph evaluates against it (a static import is
// hoisted and would run labelTexture's module body first).
installCanvasDocument((t) => ({
  actualBoundingBoxLeft: 0,
  actualBoundingBoxRight: t.length * 10,
  width: t.length * 10,
}));

const { updateAgentLabel } = await import(
  '../components/forceGraph/agentOverlayLabels.ts'
);
const { LABEL_SPRITE_CONFIG } = await import(
  '../components/forceGraph/agentOverlayConstants.ts'
);

// The floating-label sprite bakes its (pre-camera) scale as labelSize *
// heightMultiplier at build time, so a label built at labelSize N has
// scale.y === N * HM. We never render here, so onBeforeRender (camera scaling)
// never runs and the build-time scale is exactly what's asserted.
const HM = LABEL_SPRITE_CONFIG.heightMultiplier;

function makeAgent() {
  return {
    color: '#ffffff',
    pos: new THREE.Vector3(0, 0, 0),
    currentFile: 'src/api.ts',
    currentFileBase: 'api.ts',
  } as Parameters<typeof updateAgentLabel>[1];
}

test('agent label rescales when labelSize changes without a file change', () => {
  const group = new THREE.Group();
  const agent = makeAgent();

  // Label shows api.ts at size 3.
  updateAgentLabel(group, agent, 3, 10);
  const first = agent.label;
  assert.ok(first, 'label built on first update');
  assert.ok(
    Math.abs(first.scale.y - 3 * HM) < 1e-9,
    `expected initial scale.y ${3 * HM}, got ${first?.scale.y}`,
  );

  // Same file — only the Label-size slider moved. The sprite must rebuild to
  // the new size (the regression: it used to keep its old scale because the
  // text was unchanged).
  updateAgentLabel(group, agent, 6, 10);
  const second = agent.label;
  assert.ok(second, 'label still present after size change');
  assert.ok(
    Math.abs(second.scale.y - 6 * HM) < 1e-9,
    `expected rescaled scale.y ${6 * HM}, got ${second?.scale.y}`,
  );
});

test('agent label is reused when neither file nor labelSize changed', () => {
  const group = new THREE.Group();
  const agent = makeAgent();

  updateAgentLabel(group, agent, 4, 10);
  const first = agent.label;
  // Idle frame: nothing changed — must NOT rebuild (avoid per-frame churn).
  updateAgentLabel(group, agent, 4, 10);
  assert.equal(agent.label, first, 'same sprite reused when nothing changed');
});
