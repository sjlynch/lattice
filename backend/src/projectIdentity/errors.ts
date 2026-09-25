// The refusal raised whenever project identity is ambiguous; kept dependency-free
// so every projectIdentity module can throw it without an import cycle.
export class ProjectIdentityConflictError extends Error {
  constructor(message: string) { super(`[projectIdentity] ${message}`); this.name = 'ProjectIdentityConflictError'; }
}
