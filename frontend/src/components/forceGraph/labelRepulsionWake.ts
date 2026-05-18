// The LOC / health / labels overlay hooks each run a RAF that calls
// `repelLabels`. When the labels reach equilibrium the hook stops its
// RAF and releases the `idleController` `labelPhysics` reason so the
// renderer can pause. Anything that invalidates that equilibrium —
// `graph.refresh()` rebuilding the THREE objects, a settings change
// shifting `minDist`, a fresh scan adding labels — calls `wakeAll()`
// here, which restarts every hook that has registered a waker.

type Waker = () => void;

const wakers = new Set<Waker>();

export function subscribeRepulsionWake(waker: Waker): () => void {
  wakers.add(waker);
  return () => {
    wakers.delete(waker);
  };
}

export function wakeAllRepulsion(): void {
  for (const w of wakers) w();
}
