// Builds the case-insensitive matcher used by the graph search bar's filename
// pass. KEEP IN SYNC with the backend's buildSearchRegExp (backend/src/
// search.ts) so a wildcard query selects the same files whether the hit came
// from a filename match (here) or a file-contents match (backend).
//
// Wildcard mode (regex=false): `*` → any run, `?` → one char, every other
// regex metacharacter escaped; substring (unanchored) match. Regex mode
// (regex=true): the raw pattern is compiled directly. Returns null for an
// empty pattern or an invalid regex (so the caller can show an inline error
// without firing a request).
export function buildSearchRegExp(
  pattern: string,
  regex: boolean,
): RegExp | null {
  if (!pattern) return null;
  try {
    if (regex) return new RegExp(pattern, 'i');
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const translated = escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
    return new RegExp(translated, 'i');
  } catch {
    return null;
  }
}
