// Keeps a pop-out window styled exactly like the main window. Every `<style>`
// and `<link rel="stylesheet">` in the main `<head>` is cloned into the
// pop-out's head, in the same order, and a MutationObserver keeps the copy in
// step: Vite dev injects a `<style data-vite-dev-id>` per CSS module and
// rewrites its text on every CSS hot update, and a merge can add or drop whole
// stylesheets. `<html>` attributes (lang, class, inline CSS variables, data-*)
// are mirrored too, plus `<body>`'s class / data-* (never its inline style:
// drags set a transient `cursor` / `user-select` there).

type MirrorObserver = Pick<MutationObserver, 'observe' | 'disconnect'>;
export type MirrorObserverCtor = new (callback: MutationCallback) => MirrorObserver;

export function isMirroredStyleNode(node: Node): boolean {
  if (node.nodeName === 'STYLE') return true;
  if (node.nodeName !== 'LINK') return false;
  const rel = (node as Element).getAttribute('rel') ?? '';
  return /(^|\s)stylesheet(\s|$)/i.test(rel);
}

/** A `<style>`'s CSS: its text, or (for a sheet built through CSSOM `insertRule`) its rules. */
export function styleText(style: Node): string {
  const text = style.textContent ?? '';
  if (text.trim()) return text;
  try {
    const rules = (style as HTMLStyleElement).sheet?.cssRules;
    if (rules && rules.length > 0) return Array.from(rules, (rule) => rule.cssText).join('\n');
  } catch {
    /* an unreadable sheet copies as its (empty) text */
  }
  return text;
}

function copyAttributes(from: Element, to: Element, keep: (name: string) => boolean): void {
  for (const attr of Array.from(to.attributes)) {
    if (keep(attr.name) && !from.hasAttribute(attr.name)) to.removeAttribute(attr.name);
  }
  for (const attr of Array.from(from.attributes)) {
    if (keep(attr.name) && to.getAttribute(attr.name) !== attr.value) {
      to.setAttribute(attr.name, attr.value);
    }
  }
}

function syncClone(source: Node, clone: Element): void {
  copyAttributes(source as Element, clone, () => true);
  if (source.nodeName === 'LINK') {
    // Absolute: the pop-out's own URL is not the main window's.
    const href = (source as HTMLLinkElement).href;
    if (href && clone.getAttribute('href') !== href) clone.setAttribute('href', href);
  } else {
    const text = styleText(source);
    if (clone.textContent !== text) clone.textContent = text;
  }
}

const isBodyMirrored = (name: string) => name === 'class' || name.startsWith('data-');

/** Mirror `<html>` attributes and `<body>`'s class / data-* from `src` onto `dst`. */
export function syncRootAttributes(src: Document, dst: Document): void {
  copyAttributes(src.documentElement, dst.documentElement, () => true);
  if (src.body && dst.body) copyAttributes(src.body, dst.body, isBodyMirrored);
}

/**
 * Clone `src`'s stylesheets into `dst` and keep them in sync until the
 * returned stop runs (which also removes the clones).
 */
export function mirrorDocumentStyles(
  src: Document,
  dst: Document,
  Observer: MirrorObserverCtor = (src.defaultView?.MutationObserver ??
    MutationObserver) as MirrorObserverCtor,
): () => void {
  const clones = new Map<Node, Element>();

  const place = (node: Node) => {
    let clone = clones.get(node);
    if (!clone) {
      clone = dst.createElement(node.nodeName.toLowerCase());
      clones.set(node, clone);
    }
    syncClone(node, clone);
    // Before the clone of the next mirrored sibling: cascade order matches.
    let anchor: Element | null = null;
    for (let next = node.nextSibling; next; next = next.nextSibling) {
      const nextClone = clones.get(next);
      if (nextClone && nextClone.parentNode === dst.head) {
        anchor = nextClone;
        break;
      }
    }
    dst.head.insertBefore(clone, anchor);
  };

  const drop = (node: Node) => {
    const clone = clones.get(node);
    if (!clone) return;
    clones.delete(node);
    clone.parentNode?.removeChild(clone);
  };

  // The `<head>` child a mutation happened inside (a text node of a <style>).
  const headChildOf = (target: Node | null): Node | null => {
    let node = target;
    while (node && node.parentNode !== src.head) node = node.parentNode;
    return node;
  };

  for (const node of Array.from(src.head.childNodes)) if (isMirroredStyleNode(node)) place(node);
  syncRootAttributes(src, dst);

  const headObserver = new Observer((records) => {
    for (const record of records) {
      if (record.type === 'childList' && record.target === src.head) {
        record.removedNodes.forEach((node) => drop(node));
        record.addedNodes.forEach((node) => {
          if (isMirroredStyleNode(node) && node.parentNode === src.head) place(node);
        });
        continue;
      }
      const owner = headChildOf(record.target);
      if (!owner) continue;
      if (isMirroredStyleNode(owner)) place(owner);
      else drop(owner); // e.g. a <link> whose rel stopped being "stylesheet"
    }
  });
  headObserver.observe(src.head, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });

  const rootObserver = new Observer(() => syncRootAttributes(src, dst));
  rootObserver.observe(src.documentElement, { attributes: true });
  if (src.body) rootObserver.observe(src.body, { attributes: true });

  return () => {
    headObserver.disconnect();
    rootObserver.disconnect();
    for (const clone of clones.values()) {
      try {
        clone.parentNode?.removeChild(clone);
      } catch {
        /* the pop-out is gone */
      }
    }
    clones.clear();
  };
}
