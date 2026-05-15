export type OrbitControlsLockTarget = {
  enableRotate?: boolean;
  enablePan?: boolean;
};

export type OrbitControlsLock = {
  restore: () => void;
};

const noopLock: OrbitControlsLock = { restore: () => undefined };

export function disableOrbitControls(
  controls: OrbitControlsLockTarget | null | undefined,
): OrbitControlsLock {
  if (!controls) return noopLock;

  const hadOwnRotate = hasOwnFlag(controls, 'enableRotate');
  const hadOwnPan = hasOwnFlag(controls, 'enablePan');
  const previousRotate = controls.enableRotate;
  const previousPan = controls.enablePan;

  controls.enableRotate = false;
  controls.enablePan = false;

  let restored = false;
  return {
    restore() {
      if (restored) return;
      restored = true;
      restoreFlag(controls, 'enableRotate', hadOwnRotate, previousRotate);
      restoreFlag(controls, 'enablePan', hadOwnPan, previousPan);
    },
  };
}

function hasOwnFlag(
  controls: OrbitControlsLockTarget,
  key: keyof OrbitControlsLockTarget,
): boolean {
  return Object.prototype.hasOwnProperty.call(controls, key);
}

function restoreFlag(
  controls: OrbitControlsLockTarget,
  key: keyof OrbitControlsLockTarget,
  hadOwnValue: boolean,
  previousValue: boolean | undefined,
) {
  if (hadOwnValue) {
    controls[key] = previousValue;
  } else {
    delete controls[key];
  }
}
