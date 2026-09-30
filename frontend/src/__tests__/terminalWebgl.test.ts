import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachTerminalWebgl,
  disposeTerminalWebgl,
} from '../components/terminal/terminalWebgl.ts';

class FakeWebglAddon {
  disposeCalls = 0;
  readonly contextLossListeners = new Set<() => void>();
  terminal: FakeTerminal | null = null;
  failListenerRegistration = false;
  failActivation = false;
  failDisposal = false;

  constructor(failConstruction = false) {
    if (failConstruction) throw new Error('WebGL unavailable');
  }

  onContextLoss(listener: () => void) {
    this.contextLossListeners.add(listener);
    if (this.failListenerRegistration) throw new Error('Listener registration failed');
    return { dispose: () => this.contextLossListeners.delete(listener) };
  }

  activate(terminal: FakeTerminal) {
    this.terminal = terminal;
    if (this.failActivation) throw new Error('WebGL2 context creation refused');
    terminal.renderer = 'webgl';
  }

  dispose() {
    this.disposeCalls += 1;
    this.contextLossListeners.clear();
    if (this.terminal) this.terminal.renderer = 'dom';
    this.terminal = null;
    if (this.failDisposal) throw new Error('Disposal failed');
  }

  loseContext() {
    for (const listener of [...this.contextLossListeners]) listener();
  }
}

class FakeTerminal {
  readonly addons = new Set<FakeWebglAddon>();
  renderer: 'dom' | 'webgl' = 'dom';
  loadCalls = 0;
  disposed = false;
  output = '';

  loadAddon(addon: FakeWebglAddon) {
    this.loadCalls += 1;
    // Mirror xterm's AddonManager: retain and wrap dispose BEFORE activation,
    // with no rollback when activate throws.
    this.addons.add(addon);
    const dispose = addon.dispose.bind(addon);
    let disposed = false;
    addon.dispose = () => {
      if (disposed) return;
      disposed = true;
      dispose();
      this.addons.delete(addon);
    };
    addon.activate(this);
  }

  write(data: string) {
    assert.equal(this.disposed, false);
    this.output += data;
  }

  dispose() {
    for (const addon of [...this.addons]) addon.dispose();
    this.disposed = true;
  }
}

function makeHarness() {
  const term = new FakeTerminal();
  const webglRef: { current: FakeWebglAddon | null } = { current: null };
  const attempts: FakeWebglAddon[] = [];
  const activate = (configure?: (addon: FakeWebglAddon) => void) => {
    attachTerminalWebgl(term, webglRef, () => {
      const addon = new FakeWebglAddon();
      configure?.(addon);
      attempts.push(addon);
      return addon;
    });
  };
  return { term, webglRef, attempts, activate };
}

test('repeated failed activation releases every registration and listener', () => {
  const h = makeHarness();
  for (let i = 0; i < 10; i++) {
    h.activate((addon) => { addon.failActivation = true; });
    const addon = h.attempts[i];
    assert.equal(h.term.loadCalls, i + 1);
    assert.equal(h.term.addons.size, 0);
    assert.equal(h.webglRef.current, null);
    assert.equal(addon.disposeCalls, 1);
    assert.equal(addon.contextLossListeners.size, 0);
    assert.equal(addon.terminal, null);
    assert.equal(h.term.renderer, 'dom');
    h.term.write('.');
    // Deactivating after failure must not dispose the attempt again.
    disposeTerminalWebgl(h.webglRef);
    assert.equal(addon.disposeCalls, 1);
  }
  assert.equal(h.term.output, '.'.repeat(10));
  h.term.dispose();
  assert.ok(h.attempts.every((addon) => addon.disposeCalls === 1));
});

test('constructor failure leaves no add-on to register or dispose', () => {
  const h = makeHarness();
  assert.doesNotThrow(() => {
    attachTerminalWebgl(h.term, h.webglRef, () => new FakeWebglAddon(true));
  });
  assert.equal(h.webglRef.current, null);
  assert.equal(h.term.loadCalls, 0);
  assert.equal(h.term.addons.size, 0);
  disposeTerminalWebgl(h.webglRef);
  h.term.write('still usable');
});

test('listener registration failure disposes the constructed add-on', () => {
  const h = makeHarness();
  h.activate((addon) => { addon.failListenerRegistration = true; });
  assert.equal(h.attempts[0].disposeCalls, 1);
  assert.equal(h.attempts[0].contextLossListeners.size, 0);
  assert.equal(h.webglRef.current, null);
  assert.equal(h.term.loadCalls, 0);
  assert.equal(h.term.addons.size, 0);
});

test('successful activation stays owned until cleanup', () => {
  const h = makeHarness();
  h.activate();
  const addon = h.attempts[0];
  assert.equal(h.webglRef.current, addon);
  assert.equal(h.term.addons.has(addon), true);
  assert.equal(addon.disposeCalls, 0);
  assert.equal(addon.contextLossListeners.size, 1);
  assert.equal(h.term.renderer, 'webgl');

  disposeTerminalWebgl(h.webglRef);
  disposeTerminalWebgl(h.webglRef);
  assert.equal(h.webglRef.current, null);
  assert.equal(h.term.addons.size, 0);
  assert.equal(addon.disposeCalls, 1);
  assert.equal(addon.contextLossListeners.size, 0);
  assert.equal(h.term.renderer, 'dom');
  h.term.write('still usable');
  h.term.dispose();
  assert.equal(addon.disposeCalls, 1);
});

test('context loss followed by deactivate and terminal teardown disposes once', () => {
  const h = makeHarness();
  h.activate();
  const addon = h.attempts[0];
  addon.loseContext();
  assert.equal(h.webglRef.current, null);
  assert.equal(h.term.addons.size, 0);
  assert.equal(addon.disposeCalls, 1);
  assert.equal(addon.contextLossListeners.size, 0);
  assert.equal(h.term.renderer, 'dom');

  disposeTerminalWebgl(h.webglRef);
  h.term.dispose();
  assert.equal(addon.disposeCalls, 1);
});

test('terminal teardown followed by effect cleanup disposes a successful add-on once', () => {
  const h = makeHarness();
  h.activate();
  const addon = h.attempts[0];
  h.term.dispose();
  disposeTerminalWebgl(h.webglRef);
  assert.equal(h.webglRef.current, null);
  assert.equal(h.term.addons.size, 0);
  assert.equal(addon.contextLossListeners.size, 0);
  assert.equal(addon.disposeCalls, 1);
});

test('a later activation can succeed after an activation failure', () => {
  const h = makeHarness();
  h.activate((addon) => { addon.failActivation = true; });
  disposeTerminalWebgl(h.webglRef);
  h.activate();
  assert.equal(h.attempts[0].disposeCalls, 1);
  assert.equal(h.attempts[1].disposeCalls, 0);
  assert.equal(h.webglRef.current, h.attempts[1]);
  assert.deepEqual([...h.term.addons], [h.attempts[1]]);
  disposeTerminalWebgl(h.webglRef);
  assert.ok(h.attempts.every((addon) => addon.disposeCalls === 1));
});

test('failure cleanup is best-effort when dispose also throws', () => {
  const h = makeHarness();
  assert.doesNotThrow(() => {
    h.activate((addon) => {
      addon.failListenerRegistration = true;
      addon.failDisposal = true;
    });
  });
  assert.equal(h.attempts[0].disposeCalls, 1);
  assert.equal(h.webglRef.current, null);
  assert.equal(h.term.loadCalls, 0);
  h.term.write('still usable');
});
