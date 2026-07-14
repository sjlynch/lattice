// Pure rendering of the pi-mcp-adapter discovery shim (mirror of
// `piSubagents/render.ts`). Pi auto-discovers `<cwd>/.pi/extensions/*.ts`
// cwd-exactly; the shim re-exports the shared install's default export so the
// adapter loads in exactly the Lattice Pi session cwds we drop it into.

export const PI_MCP_SHIM_FILENAME = 'lattice-mcp.ts';

// Exported for unit testing.
export function renderPiMcpShim(entry: string): string {
  return `// Lattice-managed — do not commit. Loads pi-mcp-adapter from Lattice's
// shared install so the MCP servers you enabled for this project in Lattice are
// available in this Lattice Pi session. The adapter reads <cwd>/.pi/mcp.json
// (also Lattice-managed). Your global ~/.pi/agent config stays untouched. Pi
// auto-discovers any .ts in this directory; this re-exports the adapter's
// default activation fn.
export { default } from ${JSON.stringify(entry)};
`;
}
