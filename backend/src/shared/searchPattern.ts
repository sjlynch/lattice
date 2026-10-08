// Search-query → regex source, shared by the graph search bar's filename pass
// (frontend `forceGraph/searchMatcher.ts`) and the backend's file-contents
// search (`search.ts`, also handed to ripgrep), so a wildcard query selects
// the same files either way. Wildcard mode: `*` → any run, `?` → one char,
// every other metacharacter escaped (unanchored). Regex mode: the raw pattern.
export function wildcardRegexSource(pattern: string, regex: boolean): string {
  if (regex) return pattern;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
}
