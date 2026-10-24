import { useEffect, useState } from 'react';
import { isLatticeHidden, onLatticeVisibilityChange } from '../floatingPanel/popoutRegistry';

// One shared 30s ticker drives every StuckPill instead of each conflict card
// owning its own interval (many pills = many independent timers otherwise).
// It's paused while every Lattice window is hidden (a popped-out board counts
// as visible) so background tabs don't repaint, and fires once on resume so a
// foregrounded tab shows a fresh value immediately.
const tickSubscribers = new Set<() => void>();
let tickInterval: ReturnType<typeof setInterval> | null = null;
let stopTickVisibility: (() => void) | null = null;

function notifyTick() {
  for (const fn of tickSubscribers) fn();
}
function startTick() {
  if (tickInterval === null && !isLatticeHidden()) {
    tickInterval = setInterval(notifyTick, 30_000);
  }
}
function stopTick() {
  if (tickInterval !== null) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}
function onTickVisibility() {
  if (isLatticeHidden()) {
    stopTick();
  } else {
    notifyTick();
    startTick();
  }
}
function subscribeTick(fn: () => void): () => void {
  const first = tickSubscribers.size === 0;
  tickSubscribers.add(fn);
  if (first) {
    stopTickVisibility = onLatticeVisibilityChange(onTickVisibility);
    startTick();
  }
  return () => {
    tickSubscribers.delete(fn);
    if (tickSubscribers.size === 0) {
      stopTick();
      stopTickVisibility?.();
      stopTickVisibility = null;
    }
  };
}

// Surfaces "stuck Nm/Nh" on conflict cards once a resolver Claude has been
// running long enough that it might be hung. Hidden for the first 3
// minutes so we don't cry wolf on normal resolutions.
export function StuckPill({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribeTick(() => setNow(Date.now())), []);
  const minutes = Math.floor((now - since) / 60_000);
  if (minutes < 3) return null;
  const label = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
  return (
    <span
      className="task-card-stuck-pill"
      title={`Resolver has been working for ${label} — may be stuck`}
    >
      stuck {label}
    </span>
  );
}
