import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { installFakeWebSocket, installGlobal, installWindow } from './domDoubles.ts';
import { McpTab, type McpTabHandle } from '../components/settings/McpTab.tsx';
import { McpServerRow } from '../components/settings/mcp/McpServerRow.tsx';

// Regression: the MCP tab's per-project enable patches are WHOLE maps
// (`mcpOverrides` / `mcpHarnessOverrides`). It used to load them with the
// lenient `fetchUserSettings` (which returns `{}` on any failure) and flip
// `loaded` regardless — so a backend mid-restart, one toggle, and Save rewrote
// `mcpOverrides` as a one-key map, silently turning every other server off.
// Now the load is strict: a failed settings GET shows an error, keeps the
// toggles unmounted, and `getMcpUserPatch()` stays `undefined`.

const project = 'C:/mcp-proj';
const all = { claude: true, codex: true, pi: true };
const catalog = [
  { id: 'lattice', label: 'Lattice', builtin: true, defaultEnabled: true, harnessSupport: all },
  { id: 'brave-search', label: 'Brave', builtin: true, harnessSupport: all },
  { id: 'playwright', label: 'Playwright', builtin: true, harnessSupport: all },
];

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function mount(t: TestContext, settingsOk: boolean, extraSettings: object = {}) {
  const restore = [
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installGlobal('React', React),
    installWindow({ location: { protocol: 'http:', host: 'localhost:5184' } }),
    installFakeWebSocket(),
    installGlobal('fetch', (url: string) => {
      if (url.startsWith('/api/settings')) {
        return settingsOk
          ? Promise.resolve({
              ok: true,
              json: () => Promise.resolve({
                mcpOverrides: { 'brave-search': true, playwright: true },
                ...extraSettings,
              }),
            })
          : Promise.resolve({
              ok: false,
              status: 503,
              json: () => Promise.resolve({ error: 'backend restarting' }),
            });
      }
      if (url === '/api/mcp-catalog') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ servers: catalog }) });
      }
      if (url === '/api/mcp-secrets') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ redacted: {}, hints: {} }) });
      }
      if (url === '/api/mcp-env-presence') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ presence: {} }) });
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }),
  ];
  const ref = React.createRef<McpTabHandle>();
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(McpTab, { ref, active: true, open: true, activeFolder: project }),
    );
  });
  await act(async () => { await flush(); });
  t.after(() => {
    act(() => renderer.unmount());
    for (const reset of restore.reverse()) reset();
  });
  return { ref, renderer };
}

test('a failed settings load leaves the toggles unmounted and yields no patch', async (t) => {
  const { ref, renderer } = await mount(t, false);
  assert.equal(ref.current?.getMcpUserPatch(), undefined);
  assert.equal(renderer.root.findAllByType(McpServerRow).length, 0, 'no toggles to flip');
  const errorNodes = renderer.root.findAll(
    (n) => n.props.className === 'error-msg',
  );
  assert.equal(errorNodes.length, 1);
  assert.match(String(errorNodes[0].props.children), /backend restarting/);
});

test('a successful load keeps the other servers when one toggle is flipped', async (t) => {
  const { ref, renderer } = await mount(t, true);
  assert.equal(ref.current?.getMcpUserPatch(), undefined, 'untouched → no patch');
  const rows = renderer.root.findAllByType(McpServerRow);
  assert.equal(rows.length, catalog.length);
  const lattice = rows.find((r) => r.props.server.id === 'lattice')!;
  act(() => lattice.props.onToggle('claude', false));
  assert.deepEqual(ref.current?.getMcpUserPatch(), {
    mcpOverrides: { 'brave-search': true, playwright: true, lattice: false },
  });
});

// The "Task agents get only the Lattice MCP" checkbox (`taskAgentsLatticeMcpOnly`,
// default ON): its own touched flag, so an unrelated save never writes it.
function latticeOnlyBox(renderer: ReturnType<typeof TestRenderer.create>) {
  const label = renderer.root.find((n) => n.type === 'label'
    && n.findAllByType('span').some((sp) => String(sp.props.children).includes('only the Lattice MCP')));
  return label.findByType('input');
}

test('lattice-only checkbox: absent reads as on, untouched yields no patch, a flip patches just it', async (t) => {
  const { ref, renderer } = await mount(t, true);
  const box = latticeOnlyBox(renderer);
  assert.equal(box.props.checked, true);
  assert.equal(ref.current?.getMcpUserPatch(), undefined);
  act(() => box.props.onChange({ target: { checked: false } }));
  assert.deepEqual(ref.current?.getMcpUserPatch(), { taskAgentsLatticeMcpOnly: false });
});

test('lattice-only checkbox: a saved false loads unchecked', async (t) => {
  const { renderer } = await mount(t, true, { taskAgentsLatticeMcpOnly: false });
  assert.equal(latticeOnlyBox(renderer).props.checked, false);
});
