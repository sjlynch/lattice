// Peers (GET /api/peers and the pairing routes): the backend's own wire types
// (backend/src/peers/types.ts). Keys never appear in any of them.
export type {
  PeerGrantView,
  PeerInvite,
  PeerRemoteView,
  PeerScope,
  PeersView,
} from '../../../../backend/src/shared/wireTypes';
