// Shared low-level writers for the interleaved Float32Array buffers the batched
// renderers upload to the GPU: `instancedNodes.ts`'s per-instance
// `InstancedMesh.instanceMatrix.array` and `instancedLinks.ts`'s per-link
// `LineSegments` position attribute. Both used to hand-index the same magic
// offsets (`i * 16`, `+ 12`, `w + 3`, …); collecting the layout + writers here
// makes those offsets named and keeps the two hot paths writing bytes the same
// way. Pure array math — no three.js — so it stays trivially unit-testable.
//
// BUFFER LAYOUT
//
// A three.js `InstancedMesh` packs each instance's 4x4 transform COLUMN-MAJOR
// into 16 consecutive floats, instance `i` starting at `i * MATRIX_ELEMENTS`:
//
//   index:  0  1  2  3   4  5  6  7   8  9 10 11  12 13 14 15
//   column: └─ col 0 ─┘  └─ col 1 ─┘  └─ col 2 ─┘  └─ col 3 ─┘
//   role:   Xx Xy Xz Xw  Yx Yy Yz Yw  Zx Zy Zz Zw  Tx Ty Tz  1
//
// Column 3 (indices 12..14, TRANSLATION_OFFSET) is the translation — the only
// part re-written on the per-frame position sync — with a homogeneous 1 at 15.
//
// A `LineSegments` position attribute is a flat run of (x, y, z) vertex triples
// with no per-instance stride; the same `writeVertexTriple` writes both a link
// endpoint there and a matrix's translation column above.

// Floats per instance = one column-major 4x4 matrix.
export const MATRIX_ELEMENTS = 16;

// Float offset of the translation column (elements 12,13,14) within a matrix.
export const TRANSLATION_OFFSET = 12;

// Write one (x, y, z) vertex triple at float offset `o`. Used both for a
// `LineSegments` endpoint and for a matrix's translation column (pass
// `i * MATRIX_ELEMENTS + TRANSLATION_OFFSET`).
export function writeVertexTriple(
  arr: Float32Array,
  o: number,
  x: number,
  y: number,
  z: number,
): void {
  arr[o] = x;
  arr[o + 1] = y;
  arr[o + 2] = z;
}

// Write a scale+translation 4x4 matrix (column-major) at float offset `o`
// (`i * MATRIX_ELEMENTS` for instance `i`). Uniform `scale` on the X/Y diagonal,
// unit Z diagonal, `(x, y, z)` translation. Avoids allocating a THREE.Matrix4
// per instance per rebuild. Note the billboard vertex shader in instancedNodes
// only reads instanceMatrix[0][0] (scale) and column 3 (center), so the Z
// diagonal is fixed at 1 by convention.
export function writeMatrix4x4(
  arr: Float32Array,
  o: number,
  scale: number,
  x: number,
  y: number,
  z: number,
): void {
  arr[o] = scale;
  arr[o + 1] = 0;
  arr[o + 2] = 0;
  arr[o + 3] = 0;
  arr[o + 4] = 0;
  arr[o + 5] = scale;
  arr[o + 6] = 0;
  arr[o + 7] = 0;
  arr[o + 8] = 0;
  arr[o + 9] = 0;
  arr[o + 10] = 1;
  arr[o + 11] = 0;
  writeVertexTriple(arr, o + TRANSLATION_OFFSET, x, y, z);
  arr[o + 15] = 1;
}
