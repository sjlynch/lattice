import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Guard: `.sidebar-pane.hidden` must move hidden panes out of the clipped
// `.sidebar-content` box with a transform. IntersectionObserver ignores
// `visibility: hidden`, so a visibility-only rule leaves every hidden pane
// "on-screen" to xterm, which then never pauses rendering and keeps
// rebuilding DOM rows for its agent's output. `display: none` and
// `content-visibility: hidden` would pause it too, but zero the measured size
// and break xterm's character measurement and fit.

const css = readFileSync(new URL('../styles/sidebar.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\]/g, '\$&');
  const match = new RegExp(`(?:^|[}\s])${escaped}\s*\{([^}]*)\}`).exec(css);
  assert.ok(match, `${selector} rule exists`);
  return match[1];
}

test('.sidebar-pane.hidden moves the pane off-screen so xterm pauses rendering', () => {
  const body = ruleBody('.sidebar-pane.hidden');
  assert.match(body, /\bvisibility\s*:\s*hidden\b/);
  assert.match(body, /\btransform\s*:\s*translate/, 'hidden panes need an off-screen transform');
  assert.doesNotMatch(body, /\bdisplay\s*:\s*none\b/);
  assert.doesNotMatch(body, /\bcontent-visibility\b/);
});

test('.sidebar-content clips, so the translated pane stops intersecting', () => {
  assert.match(ruleBody('.sidebar-content'), /\boverflow\s*:\s*hidden\b/);
});
