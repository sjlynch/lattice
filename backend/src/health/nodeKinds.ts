// Re-export shim: the per-language node-kind tables live under
// `./nodeKinds/`. Existing callers import `./nodeKinds.js`.
export { nodeKindsFor, type NodeKinds } from './nodeKinds/index.js';
