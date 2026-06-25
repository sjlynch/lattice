import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Headless DOM + GPU-dispose instrumentation.
//
// The label-texture path allocates real <canvas> elements and THREE textures.
// node:test runs without a DOM or WebGL, so we stub `document.createElement`
// (canvas + 2D context) and record every Texture/Material `.dispose()` so the
// tests can assert exactly what got freed. labelTexture.ts creates its measure
// context lazily, so this stub only has to exist before the first build call —
// which is why the modules under test can be imported statically below.
// ---------------------------------------------------------------------------

function makeCtx(): any {
  return {
    font: '',
    textAlign: '',
    textBaseline: '',
    lineJoin: '',
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    measureText: (t: string) => ({
      actualBoundingBoxLeft: t.length * 4,
      actualBoundingBoxRight: t.length * 4,
      width: t.length * 8,
    }),
    strokeText: () => {},
    fillText: () => {},
    fillRect: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
  };
}

(globalThis as any).document = {
  createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
    const ctx = makeCtx();
    return { width: 0, height: 0, getContext: () => ctx };
  },
};

const disposedTextures = new Set<object>();
const disposedMaterials = new Set<object>();

const origTextureDispose = THREE.Texture.prototype.dispose;
THREE.Texture.prototype.dispose = function (this: object) {
  disposedTextures.add(this);
  return origTextureDispose.call(this);
};
const origMaterialDispose = THREE.Material.prototype.dispose;
THREE.Material.prototype.dispose = function (this: object) {
  disposedMaterials.add(this);
  return origMaterialDispose.call(this);
};

// Static imports are safe: none touch the DOM at module-eval time.
import {
  buildMeasuredLabelTexture,
  createLabelTextureCache,
  releaseLabelTexture,
  type LabelTextureOptions,
} from '../components/forceGraph/labelTexture.ts';
import { makeFloatingLabelSprite } from '../components/forceGraph/floatingLabelSprite.ts';
import { AgentOverlay } from '../components/forceGraph/agentOverlay.ts';

const OPTS = (maxEntries: number): LabelTextureOptions => ({
  font: 'bold 56px sans-serif',
  strokeWidth: 10,
  height: 96,
  padX: 20,
  minWidth: 96,
  maxEntries,
});

const SPRITE_CONFIG = { heightMultiplier: 1, maxScale: 100, aspectFallback: 3 };

test('eviction never disposes a texture still bound to a mounted sprite', () => {
  disposedTextures.clear();
  const cache = createLabelTextureCache();
  const opts = OPTS(256);

  // Mount 300 distinct labels at once — every build represents a live sprite,
  // so every entry is in use. The cache must grow past maxEntries rather than
  // evict (and dispose) any in-use texture.
  const textures: object[] = [];
  for (let i = 0; i < 300; i++) {
    textures.push(buildMeasuredLabelTexture(cache, `file${i}.ts`, '#ffffff', opts));
  }

  assert.equal(disposedTextures.size, 0, 'no in-use texture should be disposed');
  for (const t of textures) {
    assert.ok(!disposedTextures.has(t), 'a mounted texture was disposed');
  }
  // All 300 stayed cached (none evicted) — re-requesting one is a hit for the
  // exact same texture object.
  assert.equal(
    buildMeasuredLabelTexture(cache, 'file0.ts', '#ffffff', opts),
    textures[0],
  );
});

test('eviction reclaims released (free) entries and disposes texture + paired material', () => {
  disposedTextures.clear();
  disposedMaterials.clear();
  const cache = createLabelTextureCache();
  const opts = OPTS(4);

  // Build 4 distinct labels, each with a real sprite (→ a paired material).
  const built = [] as { tex: object; mat: object }[];
  for (let i = 0; i < 4; i++) {
    const tex = buildMeasuredLabelTexture(cache, `f${i}`, '#ffffff', opts);
    const sprite = makeFloatingLabelSprite(tex as any, 3, SPRITE_CONFIG);
    built.push({ tex, mat: sprite.material });
  }

  // f0 and f1 are no longer mounted; f2 and f3 still are.
  releaseLabelTexture(cache, built[0].tex as any);
  releaseLabelTexture(cache, built[1].tex as any);

  // 5th distinct build → cache at capacity → evict the oldest FREE entry (f0),
  // disposing its texture AND its paired material.
  buildMeasuredLabelTexture(cache, 'f4', '#ffffff', opts);
  assert.ok(disposedTextures.has(built[0].tex), 'oldest free texture evicted');
  assert.ok(disposedMaterials.has(built[0].mat), 'evicted texture\'s material freed');

  // 6th build → next oldest free is f1; the still-mounted f2/f3 are skipped.
  buildMeasuredLabelTexture(cache, 'f5', '#ffffff', opts);
  assert.ok(disposedTextures.has(built[1].tex), 'next free texture evicted');
  assert.ok(!disposedTextures.has(built[2].tex), 'in-use f2 never disposed');
  assert.ok(!disposedTextures.has(built[3].tex), 'in-use f3 never disposed');
});

test('AgentOverlay.destroy disposes agent label textures + materials', () => {
  disposedTextures.clear();
  disposedMaterials.clear();

  const scene = new THREE.Scene();
  const nodes = [
    { id: 'a', path: 'src/a.ts', x: 0, y: 0, z: 0 },
    { id: 'b', path: 'src/b.ts', x: 10, y: 5, z: 0 },
  ];
  const graph: any = {
    scene: () => scene,
    graphData: () => ({ nodes, links: [] }),
  };

  const overlay = new AgentOverlay(graph, 4);
  overlay.setAgents([{ taskId: 't1', color: '#ff0000' }], graph);
  overlay.addActivity('t1', 'src/a.ts', 'start', 1000);
  // A render tick builds the agent's file-label sprite (→ a cached texture).
  overlay.tick(1000, graph, false);

  // Find the label sprite: its texture is a MeasuredLabelTexture (has _aspect),
  // unlike the Claude node's disc texture.
  let labelTex: any = null;
  let labelMat: any = null;
  scene.traverse((obj: any) => {
    if (obj.isSprite && obj.material?.map?._aspect !== undefined) {
      labelTex = obj.material.map;
      labelMat = obj.material;
    }
  });
  assert.ok(labelTex, 'agent label texture exists after activity + tick');
  assert.ok(!disposedTextures.has(labelTex), 'label texture not disposed while mounted');

  overlay.destroy(graph);

  assert.ok(disposedTextures.has(labelTex), 'destroy disposes the agent label texture');
  assert.ok(disposedMaterials.has(labelMat), 'destroy disposes the paired material');
});
