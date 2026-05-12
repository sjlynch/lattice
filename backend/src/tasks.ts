// Public tasks entry point. The implementation lives in taskCache.ts so the
// cache/persistence/subscription mechanics can be shared with other per-project
// state stores without changing existing imports from './tasks.js'.
export * from './taskCache.js';
