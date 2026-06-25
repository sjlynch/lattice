// The `interact` reason and its DOM wiring. The user moving / clicking /
// scrolling on the canvas holds the loop at full speed, auto-released after a
// short idle tail. Owns the pointer/wheel/leave listeners on the container so
// the orchestrator stays a thin composition layer. (The tab-visibility gate is
// the other DOM signal, but it's a negative gate folded into `shouldRun`, so it
// lives with the orchestrator rather than here.)

import type { ReasonLedger } from './idleControllerReasons';

const INTERACT_IDLE_MS = 350;
const POINTER_LEAVE_TAIL_MS = 80;

export type InteractReason = {
  destroy(): void;
};

export function createInteractReason(
  container: HTMLElement,
  ledger: ReasonLedger,
  sync: () => void,
): InteractReason {
  let interactHeld = false;
  let interactTimer: ReturnType<typeof setTimeout> | null = null;

  function touchInteract(tailMs: number = INTERACT_IDLE_MS) {
    if (!interactHeld) {
      interactHeld = true;
      ledger.acquire('interact');
      sync();
    }
    if (interactTimer) clearTimeout(interactTimer);
    interactTimer = setTimeout(() => {
      interactTimer = null;
      interactHeld = false;
      ledger.release('interact');
      sync();
    }, tailMs);
  }

  const onPointerMove = () => touchInteract();
  const onPointerDown = () => touchInteract();
  const onWheel = () => touchInteract();
  // Shorten the tail aggressively when the cursor leaves the canvas so an
  // idle tab settles back to 0 CPU sooner.
  const onPointerLeave = () => touchInteract(POINTER_LEAVE_TAIL_MS);

  container.addEventListener('pointermove', onPointerMove, { passive: true });
  container.addEventListener('pointerdown', onPointerDown, { passive: true });
  container.addEventListener('wheel', onWheel, { passive: true });
  container.addEventListener('pointerleave', onPointerLeave);

  function destroy() {
    container.removeEventListener('pointermove', onPointerMove);
    container.removeEventListener('pointerdown', onPointerDown);
    container.removeEventListener('wheel', onWheel);
    container.removeEventListener('pointerleave', onPointerLeave);
    if (interactTimer) clearTimeout(interactTimer);
  }

  return { destroy };
}
