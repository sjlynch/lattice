import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMirroredStyleNode,
  mirrorDocumentStyles,
  syncRootAttributes,
  type MirrorObserverCtor,
} from '../components/floatingPanel/popoutStyles.ts';

// A popped-out panel must look exactly like it does in the main window. Every
// <style> / <link rel=stylesheet> of the main head is cloned into the pop-out,
// in cascade order, and kept in step as Vite dev rewrites a style's text on a
// CSS hot update or a merge adds / drops a stylesheet. <html> attributes and
// <body>'s class / data-* follow; <body>'s inline style (a drag's transient
// cursor) never does. A tiny fake DOM + a hand-fired MutationObserver.

const BASE = 'http://app.test';

class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  attrs = new Map<string, string>();
  text = '';
  sheet?: { cssRules: { cssText: string }[] };
  nodeName: string;
  constructor(nodeName: string) {
    this.nodeName = nodeName;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get attributes() {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }
  get href() {
    const raw = this.attrs.get('href') ?? '';
    return raw.startsWith('http') ? raw : `${BASE}${raw}`;
  }
  get textContent() {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
  }
  getAttribute(n: string) {
    return this.attrs.get(n) ?? null;
  }
  setAttribute(n: string, v: string) {
    this.attrs.set(n, String(v));
  }
  removeAttribute(n: string) {
    this.attrs.delete(n);
  }
  hasAttribute(n: string) {
    return this.attrs.has(n);
  }
  insertBefore(node: FakeNode, anchor: FakeNode | null) {
    node.parentNode?.removeChild(node);
    const i = anchor ? this.childNodes.indexOf(anchor) : -1;
    if (i < 0) this.childNodes.push(node);
    else this.childNodes.splice(i, 0, node);
    node.parentNode = this;
    return node;
  }
  appendChild(node: FakeNode) {
    return this.insertBefore(node, null);
  }
  removeChild(node: FakeNode) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
}

function el(tag: string, attrs: Record<string, string> = {}, text = '') {
  const node = new FakeNode(tag.toUpperCase());
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.text = text;
  return node;
}

function makeDoc() {
  const documentElement = el('html');
  const head = el('head');
  const body = el('body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);
  return { documentElement, head, body, defaultView: null, createElement: (tag: string) => el(tag) };
}

class ManualObserver {
  static all: ManualObserver[] = [];
  observed: unknown[] = [];
  disconnected = false;
  callback: MutationCallback;
  constructor(callback: MutationCallback) {
    this.callback = callback;
    ManualObserver.all.push(this);
  }
  observe(target: unknown) {
    this.observed.push(target);
  }
  disconnect() {
    this.disconnected = true;
  }
  fire(records: Partial<MutationRecord>[]) {
    this.callback(records as MutationRecord[], this as unknown as MutationObserver);
  }
}

function setup() {
  ManualObserver.all = [];
  const src = makeDoc();
  const dst = makeDoc();
  dst.head.appendChild(el('meta', { charset: 'UTF-8' })); // the pop-out page's own head
  const stop = mirrorDocumentStyles(
    src as unknown as Document,
    dst as unknown as Document,
    ManualObserver as unknown as MirrorObserverCtor,
  );
  const [headObserver, rootObserver] = ManualObserver.all;
  const mirrored = () =>
    dst.head.childNodes
      .filter((n) => n.nodeName !== 'META')
      .map((n) => (n.nodeName === 'LINK' ? `link:${n.getAttribute('href')}` : `style:${n.text}`));
  return { src, dst, stop, headObserver, rootObserver, mirrored };
}

test('only stylesheets are mirrored', () => {
  const is = (n: FakeNode) => isMirroredStyleNode(n as unknown as Node);
  assert.equal(is(el('style')), true);
  assert.equal(is(el('link', { rel: 'stylesheet' })), true);
  assert.equal(is(el('link', { rel: 'preload stylesheet' })), true);
  assert.equal(is(el('link', { rel: 'icon' })), false);
  assert.equal(is(el('script')), false);
  assert.equal(is(el('meta')), false);
});

test('initial copy keeps order, absolutises link hrefs, and reads CSSOM-only sheets', () => {
  ManualObserver.all = [];
  const src = makeDoc();
  src.head.appendChild(el('link', { rel: 'icon', href: '/favicon.svg' }));
  src.head.appendChild(el('style', { 'data-vite-dev-id': 'tokens.css' }, ':root{--a:1}'));
  src.head.appendChild(el('script', { src: '/main.tsx' }));
  src.head.appendChild(el('link', { rel: 'stylesheet', href: '/assets/app.css' }));
  const cssom = el('style');
  cssom.sheet = { cssRules: [{ cssText: '.x { color: red; }' }, { cssText: '.y { color: blue; }' }] };
  src.head.appendChild(cssom);
  const dst = makeDoc();
  mirrorDocumentStyles(src as unknown as Document, dst as unknown as Document, ManualObserver as unknown as MirrorObserverCtor);

  assert.deepEqual(
    dst.head.childNodes.map((n) => [n.nodeName, n.getAttribute('href') ?? n.text]),
    [
      ['STYLE', ':root{--a:1}'],
      ['LINK', `${BASE}/assets/app.css`],
      ['STYLE', '.x { color: red; }\n.y { color: blue; }'],
    ],
  );
  assert.equal(dst.head.childNodes[0].getAttribute('data-vite-dev-id'), 'tokens.css');
});

test('HMR: a rewritten style, an added and a removed stylesheet all follow', () => {
  const { src, headObserver, mirrored } = setup();
  const a = el('style', {}, '.a{}');
  const c = el('style', {}, '.c{}');
  src.head.appendChild(a);
  src.head.appendChild(c);
  headObserver.fire([{ type: 'childList', target: src.head as unknown as Node, addedNodes: [a, c] as unknown as NodeList, removedNodes: [] as unknown as NodeList }]);
  assert.deepEqual(mirrored(), ['style:.a{}', 'style:.c{}']);

  // Vite's CSS hot update rewrites the text (a mutation inside the <style>).
  a.text = '.a{color:red}';
  const textNode = el('#text');
  textNode.parentNode = a;
  headObserver.fire([{ type: 'characterData', target: textNode as unknown as Node }]);
  assert.deepEqual(mirrored(), ['style:.a{color:red}', 'style:.c{}']);

  // A stylesheet inserted between two others lands between their clones.
  const b = el('link', { rel: 'stylesheet', href: '/b.css' });
  src.head.insertBefore(b, c);
  headObserver.fire([{ type: 'childList', target: src.head as unknown as Node, addedNodes: [b] as unknown as NodeList, removedNodes: [] as unknown as NodeList }]);
  assert.deepEqual(mirrored(), ['style:.a{color:red}', `link:${BASE}/b.css`, 'style:.c{}']);

  // Removed from the main head → removed from the pop-out.
  src.head.removeChild(a);
  headObserver.fire([{ type: 'childList', target: src.head as unknown as Node, addedNodes: [] as unknown as NodeList, removedNodes: [a] as unknown as NodeList }]);
  assert.deepEqual(mirrored(), [`link:${BASE}/b.css`, 'style:.c{}']);

  // A link whose rel stops being "stylesheet" is dropped; its href change before that followed.
  b.setAttribute('href', '/b2.css');
  headObserver.fire([{ type: 'attributes', target: b as unknown as Node }]);
  assert.deepEqual(mirrored(), [`link:${BASE}/b2.css`, 'style:.c{}']);
  b.setAttribute('rel', 'preload');
  headObserver.fire([{ type: 'attributes', target: b as unknown as Node }]);
  assert.deepEqual(mirrored(), ['style:.c{}']);
});

test('<html> attributes mirror fully; <body> only class / data-*', () => {
  const src = makeDoc();
  const dst = makeDoc();
  src.documentElement.setAttribute('lang', 'en');
  src.documentElement.setAttribute('style', '--accent: #fff');
  src.documentElement.setAttribute('data-theme', 'dark');
  src.body.setAttribute('class', 'has-timeline');
  src.body.setAttribute('data-mode', 'x');
  src.body.setAttribute('style', 'cursor: ew-resize');
  dst.documentElement.setAttribute('data-stale', '1');
  dst.body.setAttribute('style', 'margin: 0');

  syncRootAttributes(src as unknown as Document, dst as unknown as Document);
  assert.deepEqual(Object.fromEntries(dst.documentElement.attrs), {
    lang: 'en',
    style: '--accent: #fff',
    'data-theme': 'dark',
  });
  assert.deepEqual(Object.fromEntries(dst.body.attrs), {
    style: 'margin: 0', // the pop-out's own; the main body's drag cursor never copies
    class: 'has-timeline',
    'data-mode': 'x',
  });

  src.body.removeAttribute('class');
  syncRootAttributes(src as unknown as Document, dst as unknown as Document);
  assert.equal(dst.body.hasAttribute('class'), false);
});

test('a root attribute change re-syncs; stop disconnects and removes every clone', () => {
  const { src, dst, stop, headObserver, rootObserver, mirrored } = setup();
  assert.deepEqual(rootObserver.observed, [src.documentElement, src.body]);
  src.documentElement.setAttribute('class', 'focus-mode');
  rootObserver.fire([{ type: 'attributes', target: src.documentElement as unknown as Node }]);
  assert.equal(dst.documentElement.getAttribute('class'), 'focus-mode');

  const s = el('style', {}, '.s{}');
  src.head.appendChild(s);
  headObserver.fire([{ type: 'childList', target: src.head as unknown as Node, addedNodes: [s] as unknown as NodeList, removedNodes: [] as unknown as NodeList }]);
  assert.deepEqual(mirrored(), ['style:.s{}']);

  stop();
  assert.equal(headObserver.disconnected, true);
  assert.equal(rootObserver.disconnected, true);
  assert.deepEqual(mirrored(), []);
  assert.equal(dst.head.childNodes.length, 1, "the pop-out page's own <meta> stays");
});
