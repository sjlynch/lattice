// Types for the Lattice API. Wire types the backend declares in a node-free
// module are re-exported from backend/src/shared/wireTypes.ts; the files here
// only compose WS envelopes / request bodies from them or declare what the
// backend can't share yet (see ./CLAUDE.md for which and why).

export * from './health';
export * from './scan';
export * from './gitHistory';
export * from './git';
export * from './settings';
export * from './opengrep';
export * from './projectEnv';
export * from './instructionTemplates';
export * from './harnessSystemPrompts';
export * from './tasks';
export * from './runs';
export * from './postMergeHooks';
export * from './workflows';
export * from './terminalTabs';
