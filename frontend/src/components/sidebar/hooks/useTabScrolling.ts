import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { TerminalSpec } from '../../../TerminalsContext';

const SCROLL_STEP = 160;

export type TabScrollMetrics = {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
};

export type TabScrollState = {
  canScrollLeft: boolean;
  canScrollRight: boolean;
};

// Pure: derive the arrows' enabled/disabled state from the strip's scroll
// geometry. Exported so the affordance logic is unit-testable without a DOM.
export function computeTabScrollState(
  metrics: TabScrollMetrics | null,
): TabScrollState {
  if (!metrics) return { canScrollLeft: false, canScrollRight: false };
  const { scrollLeft, scrollWidth, clientWidth } = metrics;
  return {
    canScrollLeft: scrollLeft > 1,
    canScrollRight: scrollLeft + clientWidth < scrollWidth - 1,
  };
}

// The slice of the tab-strip element subscribeTabScroll needs. Real
// HTMLDivElements satisfy it; a test can supply a structural fake so the
// scroll/resize subscription can be driven without a DOM.
export type TabScrollNode = TabScrollMetrics & {
  addEventListener: (
    type: 'scroll',
    handler: () => void,
    options?: AddEventListenerOptions,
  ) => void;
  removeEventListener: (type: 'scroll', handler: () => void) => void;
};

// Wire a strip node's scroll + resize signals to `onUpdate`, returning a
// teardown. Pulled out of the effect so the listener wiring is testable and so
// the effect re-runs this on (re)mount of the strip.
export function subscribeTabScroll(
  node: TabScrollNode,
  onUpdate: () => void,
): () => void {
  const onScroll = () => onUpdate();
  node.addEventListener('scroll', onScroll, { passive: true });
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const ro = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(onUpdate, 150);
  });
  ro.observe(node as unknown as Element);
  return () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    node.removeEventListener('scroll', onScroll);
    ro.disconnect();
  };
}

type UseTabScrollingArgs = {
  activeId: string | null;
  visibleTerminals: TerminalSpec[];
};

export function useTabScrolling({ activeId, visibleTerminals }: UseTabScrollingArgs) {
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);

  const updateScrollState = useCallback(() => {
    const next = computeTabScrollState(tabsRef.current);
    setCanScrollLeft(next.canScrollLeft);
    setCanScrollRight(next.canScrollRight);
  }, []);

  useLayoutEffect(() => {
    updateScrollState();
  }, [visibleTerminals, updateScrollState]);

  // Subscribe the strip's scroll + resize signals. `visibleTerminals` is in the
  // deps (mirroring the layout effect above) so this re-runs and attaches once
  // the strip node actually exists: the sidebar can first mount with zero
  // terminals, in which case there's no strip and `tabsRef.current` is null at
  // the effect's first run. Because `updateScrollState` is permanently stable,
  // a `[updateScrollState]`-only dep would never re-run the effect after the
  // strip later mounts, leaving the scroll listener + ResizeObserver unattached
  // and the arrows frozen at their last layout-effect state.
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    return subscribeTabScroll(el, updateScrollState);
  }, [visibleTerminals, updateScrollState]);

  useEffect(() => {
    const el = activeTabRef.current;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  const scrollTabs = useCallback((dir: 1 | -1) => {
    const el = tabsRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * SCROLL_STEP, behavior: 'smooth' });
  }, []);

  return {
    tabsRef,
    activeTabRef,
    canScrollLeft,
    canScrollRight,
    scrollTabs,
  };
}
