// Source-graph scan, content search and folder-browser payloads. The folder
// browser's `DirListing` family is the backend's own
// (backend/src/fsbrowse/types.ts, re-exported through
// backend/src/shared/wireTypes.ts). The graph/search types stay declared here:
// their backend modules (scanner/, search.ts) import node.
import type { HealthMetrics } from './health';

export type {
  DirEntry,
  DirListing,
  DirRoot,
} from '../../../../backend/src/shared/wireTypes';

export type GraphNode = {
  id: string;
  name: string;
  path: string;
  kind: 'dir' | 'file';
  ext?: string;
  size?: number;
  health?: number;
  healthDetails?: HealthMetrics;
  loc?: number;
};

export type GraphLink = {
  source: string;
  target: string;
};

export type ScanResult = {
  root: string;
  nodes: GraphNode[];
  links: GraphLink[];
};

// Result of a file-contents search (GET /api/search). `matches` holds
// absolute file paths, which are identical to the graph's file-node ids.
export type SearchResult = {
  matches: string[];
  scanned: number;
  truncated: boolean;
};
