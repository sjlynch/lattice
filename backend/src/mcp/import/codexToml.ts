// Minimal hand-rolled TOML reader for Codex's `[mcp_servers.<name>]` tables.
// Independent of MCP normalization — pure string parsing, no dependency added.

import { type RawServer } from './normalize.js';

// Reads `[mcp_servers.<name>]` tables only. Handles single-line strings, string
// arrays, and inline `{ K = "v" }` tables (for env). Anything fancier
// (multi-line arrays, nested tables) is ignored — best-effort by design.
export function parseCodexMcpServers(text: string): Record<string, RawServer> {
  const out: Record<string, RawServer> = {};
  let current: RawServer | null = null;
  const header = /^\[mcp_servers\.("?)([^"\].]+)\1\]\s*$/;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const h = header.exec(line);
    if (h) {
      current = {};
      out[h[2]] = current;
      continue;
    }
    if (line.startsWith('[')) {
      current = null; // left the mcp_servers section
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    (current as Record<string, unknown>)[key] = parseTomlValue(value);
  }
  return out;
}

function stripTomlComment(line: string): string {
  // Drop a trailing `#` comment that isn't inside a quoted string.
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inStr = !inStr;
    else if (ch === '#' && !inStr) return line.slice(0, i);
  }
  return line;
}

function parseTomlValue(value: string): unknown {
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s));
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const obj: Record<string, string> = {};
    for (const pair of value.slice(1, -1).split(',')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const k = pair.slice(0, eq).trim();
      let v = pair.slice(eq + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (k) obj[k] = v;
    }
    return obj;
  }
  return value;
}
