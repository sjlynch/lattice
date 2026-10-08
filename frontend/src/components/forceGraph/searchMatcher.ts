// Builds the case-insensitive matcher used by the graph search bar's filename
// pass. The wildcard translation is the backend content search's own
// (backend/src/shared/searchPattern.ts), so a wildcard query selects the same
// files whether the hit came from a filename match (here) or file contents.
//
// Wildcard mode (regex=false): `*` → any run, `?` → one char, every other
// regex metacharacter escaped; substring (unanchored) match. Regex mode
// (regex=true): the raw pattern is compiled directly. Returns null for an
// empty pattern or an invalid regex (so the caller can show an inline error
// without firing a request).
import { wildcardRegexSource } from '../../../../backend/src/shared/searchPattern';

export function buildSearchRegExp(
  pattern: string,
  regex: boolean,
): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(wildcardRegexSource(pattern, regex), 'i');
  } catch {
    return null;
  }
}
