// Persist-gating decision for useHiddenExtensions, factored out as a pure
// function so the folder-switch corruption guard is unit-testable without a
// React renderer.
//
// The hook has two effects keyed on the same `hiddenExtsKey`: a load effect
// (repopulates `hiddenExts` from storage for the active project) and a persist
// effect (writes `hiddenExts` back). On a folder switch the key changes one
// render BEFORE the load effect commits the new project's set, so on that
// render `hiddenExts` still holds the PREVIOUS project's value. Persisting it
// then would stamp project A's hidden set onto project B's key. Setting a ref
// inside the load effect can't gate this — within a single commit the load
// effect runs first and would mark the ref as already-loaded for the new key,
// so the persist effect can't tell the value is stale. Instead the persist
// effect tracks the key IT last reconciled and skips the write on the render
// where that key changed; the next render (after the load effect commits the
// new project's set) persists the correct value.
export function reconcileHiddenExtsPersist(
  currentKey: string | null,
  lastReconciledKey: string | null,
): { write: boolean; nextKey: string | null } {
  // No active project → nothing to persist; leave the tracked key untouched so
  // a later switch back to a real key is still seen as a key change.
  if (!currentKey) return { write: false, nextKey: lastReconciledKey };
  // Key just changed (folder switch, or first run): the current `hiddenExts`
  // belongs to the previous key, not this one. Record the new key and skip.
  if (lastReconciledKey !== currentKey)
    return { write: false, nextKey: currentKey };
  // Key is stable → this is a genuine `hiddenExts` mutation; persist it.
  return { write: true, nextKey: currentKey };
}
