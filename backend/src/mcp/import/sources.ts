// Per-tool config source readers: locate and read each other tool's MCP config
// files, then hand each server map to `normalizeServer`. All read-only and
// best-effort — a missing/unparseable file is silently skipped.
//
// Sources:
//   Claude Code — ~/.claude.json (global + projects[*]), ~/.claude/settings.json,
//                 project .mcp.json
//   Cursor      — ~/.cursor/mcp.json, project .cursor/mcp.json
//   Codex       — ~/.codex/config.toml  [mcp_servers.*]  (minimal TOML reader)
//   VS Code     — project .vscode/mcp.json + user mcp.json  (servers + inputs)
//   Windsurf    — ~/.codeium/windsurf/mcp_config.json

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MANAGED_MCP_MARKER } from '../claudeInject.js';
import { parseCodexMcpServers } from './codexToml.js';
import { asStringArray, normalizeServer, type Normalized, type RawServer } from './normalize.js';

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function serversFromMap(
  map: unknown,
  source: string,
  skip: (name: string) => boolean = () => false,
): Normalized[] {
  if (!map || typeof map !== 'object') return [];
  const out: Normalized[] = [];
  for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
    if (skip(name)) continue;
    const n = normalizeServer(name, raw as RawServer, source);
    if (n) out.push(n);
  }
  return out;
}

export async function collectClaude(projectPath?: string): Promise<Normalized[]> {
  const out: Normalized[] = [];
  const home = os.homedir();

  const claudeJson = await readJson(path.join(home, '.claude.json'));
  if (claudeJson) {
    out.push(...serversFromMap(claudeJson.mcpServers, 'Claude Code (~/.claude.json)'));
    // Per-project entries — but skip servers Lattice itself manages there.
    const projects = claudeJson.projects;
    if (projects && typeof projects === 'object') {
      for (const entry of Object.values(projects as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const managed = new Set(asStringArray(e[MANAGED_MCP_MARKER]));
        out.push(
          ...serversFromMap(
            e.mcpServers,
            'Claude Code (project config)',
            (name) => managed.has(name),
          ),
        );
      }
    }
  }

  const settingsJson = await readJson(path.join(home, '.claude', 'settings.json'));
  if (settingsJson) {
    out.push(...serversFromMap(settingsJson.mcpServers, 'Claude Code (settings.json)'));
  }

  if (projectPath) {
    const mcpJson = await readJson(path.join(projectPath, '.mcp.json'));
    if (mcpJson) out.push(...serversFromMap(mcpJson.mcpServers, 'Claude Code (.mcp.json)'));
  }

  return out;
}

export async function collectCursor(projectPath?: string): Promise<Normalized[]> {
  const out: Normalized[] = [];
  const global = await readJson(path.join(os.homedir(), '.cursor', 'mcp.json'));
  if (global) out.push(...serversFromMap(global.mcpServers, 'Cursor (~/.cursor/mcp.json)'));
  if (projectPath) {
    const proj = await readJson(path.join(projectPath, '.cursor', 'mcp.json'));
    if (proj) out.push(...serversFromMap(proj.mcpServers, 'Cursor (project)'));
  }
  return out;
}

export async function collectWindsurf(): Promise<Normalized[]> {
  const file = path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json');
  const json = await readJson(file);
  return json ? serversFromMap(json.mcpServers, 'Windsurf') : [];
}

export async function collectVsCode(projectPath?: string): Promise<Normalized[]> {
  const out: Normalized[] = [];
  // VS Code uses `servers` (not `mcpServers`) and `${input:…}` references.
  const userMcp = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Code', 'User', 'mcp.json')
    : path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json');
  const user = await readJson(userMcp);
  if (user) out.push(...serversFromMap(user.servers, 'VS Code (user)'));
  if (projectPath) {
    const proj = await readJson(path.join(projectPath, '.vscode', 'mcp.json'));
    if (proj) out.push(...serversFromMap(proj.servers, 'VS Code (.vscode/mcp.json)'));
  }
  return out;
}

export async function collectCodex(): Promise<Normalized[]> {
  try {
    const text = await fs.readFile(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
    const map = parseCodexMcpServers(text);
    return serversFromMap(map, 'Codex (~/.codex/config.toml)');
  } catch {
    return [];
  }
}
