import { useLayoutEffect, useRef } from 'react';
import type { GraphNode } from '../../api';
import type { OpengrepGraphResult } from '../../api/opengrep';
import { getLastCursor } from './cursorTracker';
import { clampPosition } from './tooltipPosition';
import { securityFilesByPath, securityPathKey, SECURITY_COLORS } from './securityOverlay';

export function SecurityTooltip({ node, result }: { node: GraphNode; result: OpengrepGraphResult }) {
  const ref = useRef<HTMLDivElement>(null);
  const file = securityFilesByPath(result).get(securityPathKey(node.path));
  const findings = result.findings?.filter((finding) => finding.path === file?.path) ?? [];
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = el.offsetWidth, height = el.offsetHeight, frame: number | null = null;
    let cursor = getLastCursor();
    const place = () => {
      frame = null;
      if (!cursor) return;
      const position = clampPosition(cursor.clientX, cursor.clientY, width, height);
      el.style.transform = `translate3d(${position.left}px, ${position.top}px, 0)`;
      el.style.visibility = 'visible';
    };
    const onMove = (e: PointerEvent) => { cursor = e; if (frame === null) frame = requestAnimationFrame(place); };
    const measure = () => { width = el.offsetWidth; height = el.offsetHeight; place(); };
    place(); window.addEventListener('pointermove', onMove); window.addEventListener('resize', measure);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('resize', measure); if (frame !== null) cancelAnimationFrame(frame); };
  }, [node.path, result]);
  return <div className="security-tooltip" role="tooltip" ref={ref}>
    <strong>{file?.path ?? node.name}</strong>
    <div className="security-tooltip-counts">{(['ERROR', 'WARNING', 'INFO'] as const).map((severity) => <span key={severity} style={{ color: SECURITY_COLORS[severity] }}>{findings.filter((f) => f.severity === severity).length} {severity}</span>)}</div>
    {file?.stale && <p>Saved results · freshness needs updating</p>}
    {(!file || file.incomplete) && <p>Unscanned or incomplete coverage</p>}
    {file && !file.incomplete && findings.length === 0 && <p>No findings shown with the current filters.</p>}
    {findings.slice(0, 3).map((f) => <p className="security-tooltip-preview" key={f.fingerprint}><span style={{ color: SECURITY_COLORS[f.severity] }}>L{f.line}</span> {f.message}</p>)}
    {findings.length > 3 && <small>+{findings.length - 3} more findings</small>}
    <small>Click the node to view findings</small>
  </div>;
}
