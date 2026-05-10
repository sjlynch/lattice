import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { TerminalSpec } from '../../../TerminalsContext';

const SCROLL_STEP = 160;

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
    const el = tabsRef.current;
    if (!el) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setCanScrollLeft(scrollLeft > 1);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
  }, []);

  useLayoutEffect(() => {
    updateScrollState();
  }, [visibleTerminals, updateScrollState]);

  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const onScroll = () => updateScrollState();
    el.addEventListener('scroll', onScroll, { passive: true });
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(updateScrollState, 150);
    });
    ro.observe(el);
    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [updateScrollState]);

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
