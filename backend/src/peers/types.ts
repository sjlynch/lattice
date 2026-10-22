// Wire types of the peers surface (GET /api/peers and friends) — node-free,
// re-exported through ../shared/wireTypes.ts to the frontend. Keys never
// appear in any of these.

// Cumulative: `operate` includes `read`, `terminals` includes both.
//   read      — the Fleet snapshot, boards, runs, workflows, plan usage
//   operate   — + create / update / run tasks, start workflows / merges,
//               launch agents
//   terminals — + read, type into and wait on terminals
export type PeerScope = 'read' | 'operate' | 'terminals';

// A PC allowed to reach THIS machine's gateway (we invited it).
export type PeerGrantView = {
  identity: string;
  name: string;
  scope: PeerScope;
  createdAt: number;
  lastSeenAt?: number;
};

// A PC this machine connects TO (we pasted its invite).
export type PeerRemoteView = {
  name: string;
  host: string;
  port: number;
  addedAt: number;
};

export type PeersView = {
  gateway: {
    enabled: boolean;
    port: number;
    listening: boolean;
    // Non-internal IPv4 addresses other PCs can reach this one at.
    addresses: string[];
    error?: string;
  };
  grants: PeerGrantView[];
  remotes: PeerRemoteView[];
};

// POST /api/peers/invites → the one-time connection string for the other PC.
export type PeerInvite = {
  identity: string;
  name: string;
  scope: PeerScope;
  connection: string;
};
