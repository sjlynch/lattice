// MCP injection hygiene: reconcileMcpServers (add/strip/preserve) + the win32
// package-runner wrapping. Split out of the original monolithic mcp.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MANAGED_MCP_MARKER,
  platformizeCommand,
  reconcileMcpServers,
  type ClaudeMcpServerConfig,
} from '../mcp/claudeInject.js';

// ---- reconcileMcpServers: the injection-hygiene contract ----
//
// Managed servers are added/updated, previously-managed-now-disabled ones are
// stripped, and the user's own hand-added entries are never touched.

function cfg(command: string): ClaudeMcpServerConfig {
  return { type: 'stdio', command };
}

test('reconcile adds managed servers and records the marker', () => {
  const entry: Record<string, unknown> = {};
  reconcileMcpServers(entry, { brave: cfg('npx') });
  assert.deepEqual(entry.mcpServers, { brave: cfg('npx') });
  assert.deepEqual(entry[MANAGED_MCP_MARKER], ['brave']);
});

test('reconcile preserves the user’s own (unmanaged) servers', () => {
  const entry: Record<string, unknown> = {
    mcpServers: { mine: cfg('node') },
  };
  reconcileMcpServers(entry, { brave: cfg('npx') });
  assert.deepEqual(entry.mcpServers, { mine: cfg('node'), brave: cfg('npx') });
});

test('reconcile strips a previously-managed server that is now disabled', () => {
  const entry: Record<string, unknown> = {
    mcpServers: { brave: cfg('npx'), mine: cfg('node') },
    [MANAGED_MCP_MARKER]: ['brave'],
  };
  // brave no longer in the managed set → stripped; user's `mine` stays.
  reconcileMcpServers(entry, {});
  assert.deepEqual(entry.mcpServers, { mine: cfg('node') });
  assert.equal(entry[MANAGED_MCP_MARKER], undefined);
});

test('reconcile drops the marker when nothing is managed', () => {
  const entry: Record<string, unknown> = {};
  reconcileMcpServers(entry, {});
  assert.deepEqual(entry.mcpServers, {});
  assert.ok(!(MANAGED_MCP_MARKER in entry));
});

// ---- platformizeCommand: Windows package-runner wrapping ----

test('platformizeCommand wraps npx in cmd /c on win32, passes node through', () => {
  const wrapped = platformizeCommand('npx', ['-y', 'pkg']);
  const node = platformizeCommand('node', ['server.js']);
  if (process.platform === 'win32') {
    assert.deepEqual(wrapped, { command: 'cmd', args: ['/c', 'npx', '-y', 'pkg'] });
    assert.deepEqual(node, { command: 'node', args: ['server.js'] });
  } else {
    assert.deepEqual(wrapped, { command: 'npx', args: ['-y', 'pkg'] });
  }
});
