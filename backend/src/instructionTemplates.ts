// Editable agent-brief templates — the public facade over
// ./instructionTemplates/ (defs/catalog, apply engine, per-project override
// resolution, settings-editor payload). See ./instructionTemplates/CLAUDE.md.
export * from './instructionTemplates/apply.js';
export * from './instructionTemplates/defs.js';
export * from './instructionTemplates/resolve.js';
export * from './instructionTemplates/editorData.js';
