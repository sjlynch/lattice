import type { RefObject } from 'react';
import { GraphViewOverlays, type GraphViewOverlaysProps } from './GraphViewOverlays';

export type GraphViewChromeProps = {
  hasTimeline: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  overlays: GraphViewOverlaysProps;
};

export function GraphViewChrome({
  hasTimeline,
  containerRef,
  overlays,
}: GraphViewChromeProps) {
  return (
    <div
      className={hasTimeline ? 'has-timeline' : undefined}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <GraphViewOverlays {...overlays} />
    </div>
  );
}
