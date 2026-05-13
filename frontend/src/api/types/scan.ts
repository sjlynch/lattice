import type { HealthMetrics } from './health';

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

export type DirEntry = { name: string; path: string };
export type DirRoot = { name: string; path: string };
export type DirListing = {
  path: string;
  parent: string | null;
  roots?: DirRoot[];
  entries: DirEntry[];
};
