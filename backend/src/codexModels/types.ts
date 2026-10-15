// Wire type of GET /api/codex-models (node-free: re-exported through
// ../shared/wireTypes.ts to the frontend).
export interface CodexModelInfo {
  id: string;
  displayName: string;
  description: string;
  /** Reasoning efforts the model accepts (Codex's own list; may include ones Lattice doesn't offer). */
  efforts: string[];
  defaultEffort?: string;
}
