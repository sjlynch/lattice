// Side-effect helper: tear down a backend pty session. Kept out of the React
// state layer so it cannot accidentally run inside a setState updater — in
// StrictMode dev that would fire twice and DELETE the pty session twice,
// which on Windows previously crashed node-pty's helper subprocess and
// brought the whole backend down.
export function deleteBackendSession(serverId: string): void {
  void fetch(`/api/terminals/${encodeURIComponent(serverId)}`, {
    method: 'DELETE',
  }).catch(() => {
    /* ignore */
  });
}
