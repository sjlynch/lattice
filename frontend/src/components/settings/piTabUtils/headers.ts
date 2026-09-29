// Drop blank/whitespace header keys and omit the map entirely when empty, so a
// half-typed header row never reaches models.json.
export function cleanHeaders(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.trim();
    if (key) out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// Rebuild a header record from ordered [key,value] pairs. fromEntries keeps
// insertion order (so editing a key in place doesn't reshuffle rows) and a
// transient empty/duplicate key just collapses — fine mid-edit.
export function entriesToHeaders(
  entries: [string, string][],
): Record<string, string> {
  return Object.fromEntries(entries);
}

// The lowest `header-N` placeholder key not already used by a row. Deriving it
// from the row COUNT re-minted a key still in use once an earlier row was
// removed (add, add, remove the first, add → a second `header-2`), and since
// headers are a record the blank new row then replaced the filled-in one — an
// auth header reconciled into models.json without its value.
export function nextHeaderKey(entries: [string, string][]): string {
  const used = new Set(entries.map(([k]) => k));
  let n = 1;
  while (used.has(`header-${n}`)) n++;
  return `header-${n}`;
}

// The header-row editors, as pure `headers → headers` updaters over the rows in
// insertion order. An out-of-range row index is a no-op.
export function addHeaderEntry(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const entries = Object.entries(headers ?? {});
  return entriesToHeaders([...entries, [nextHeaderKey(entries), '']]);
}

export function removeHeaderEntry(
  headers: Record<string, string> | undefined,
  rowIdx: number,
): Record<string, string> {
  return entriesToHeaders(
    Object.entries(headers ?? {}).filter((_, i) => i !== rowIdx),
  );
}

export function setHeaderKey(
  headers: Record<string, string> | undefined,
  rowIdx: number,
  key: string,
): Record<string, string> {
  return entriesToHeaders(
    Object.entries(headers ?? {}).map(([k, v], i): [string, string] =>
      i === rowIdx ? [key, v] : [k, v],
    ),
  );
}

export function setHeaderValue(
  headers: Record<string, string> | undefined,
  rowIdx: number,
  value: string,
): Record<string, string> {
  return entriesToHeaders(
    Object.entries(headers ?? {}).map(([k, v], i): [string, string] =>
      i === rowIdx ? [k, value] : [k, v],
    ),
  );
}
