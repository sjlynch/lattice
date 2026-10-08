// Types for the Lattice API. `tasks.ts` and `terminalTabs.ts` re-export the
// backend's own wire types (backend/src/shared/wireTypes.ts); the rest are
// still hand-maintained mirrors — move a type to the shared re-export when you
// touch it (see backend/src/shared/CLAUDE.md).

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
