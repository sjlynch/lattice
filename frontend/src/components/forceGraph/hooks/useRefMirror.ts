import { useEffect, useRef, type MutableRefObject } from 'react';

// Keeps a ref in sync with a value. Used so closures wired into the
// 3d-force-graph instance once at mount can still read the live value
// (state would be captured by the closure, but a ref is dereferenced
// each call).
export function useRefMirror<T>(value: T): MutableRefObject<T> {
  const ref = useRef<T>(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
