# backend/src/peers

Peers: other PCs running Lattice, paired so Fleet (and agents the user
allows) can see and drive their projects. Facade: `../peers.ts`. Routes:
`../routes/peers.ts`. UI: Fleet → PCs (`frontend/src/components/fleet/FleetPeersPanel.tsx`).

## Map

- `types.ts` — node-free wire types (`PeersView`, `PeerInvite`, `PeerScope`); never keys.
- `store.ts` — `~/.lattice/peers.json`: gateway switch + port, grants (PCs
  allowed in) and remotes (PCs we connect to), with their keys; locked
  read-modify-write, corrupt file never replaced; views strip keys.
- `connection.ts` — the invite string `lattice-peer:1:<host>:<port>:<identity>:<key>`
  and `lanAddresses`.
- `gateway.ts` — the TLS-PSK listener: scope allowlist, Origin refusal, rate
  and size limits, loopback forwarding with the per-process gateway token,
  audit log (`~/.lattice/logs/peer-gateway.jsonl`), revocation.
- `client.ts` — `peerRequest`: one TLS-PSK connection per request.

## Security model (load-bearing)

- **Off by default.** The gateway is the only Lattice listener beyond
  127.0.0.1, and only while the user has it on. Switching it, inviting,
  revoking, pairing and unpairing are **browser-only** routes — an agent can
  never open the LAN or mint access.
- **TLS 1.2, ECDHE-PSK ciphers only** (`PEER_CIPHERS`): a random 256-bit key
  per grant authenticates both ends; ECDHE gives forward secrecy; no
  certificates. Unknown identity or wrong key fails the handshake.
- **One connection per request on the client** (`agent: false`). A pooled
  socket is authenticated once; reusing it let a wrong key ride a connection
  made with the right one (caught in the prototype — pinned by
  `peers.gateway.test.ts`).
- **Scope per grant** (`read` ⊂ `operate` ⊂ `terminals`) checked against a
  fixed allowlist (`requiredScope`). Settings, global settings, pairing,
  deletes, raw terminal creation and the `/api/peer` proxy are unreachable
  for any scope — so peers can't chain through a PC.
- **Forwarded requests carry `GATEWAY_TOKEN`** (random per process, never
  sent off the machine) plus the scope; `forwardedPeerScope` trusts only that.
  Fleet's control gate accepts a forwarded request whose scope covers the
  action; an agent launch arriving from a peer is always a scoped
  (`fleet-agent`) launch.
- A request carrying `Origin` is refused (browsers can't speak PSK).
- A snapshot served to a peer never includes ITS peers (no A↔B loops).
- Invites travel like passwords: shown once, never readable again.
- Tests and e2e bind loopback (`LATTICE_PEER_GATEWAY_HOST=127.0.0.1`).

## Tests

`peers.gateway.test.ts` (handshake, socket reuse, scopes, Origin, forwarding
headers, audit, revocation), `peers.routes.test.ts` (browser-only pairing,
key-free views, proxy, agent gate, revoke — pairing the process with
itself), e2e `fleet.spec.ts` (pairing through the UI).
