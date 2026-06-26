export type ProjectItemLookup<TItem> = {
  project: string;
  list: TItem[];
  idx: number;
  item: TItem;
};

// Linear scan over every currently-loaded project's cached list for an item
// whose id matches. Only meaningful when the state is an item array (tasks,
// workflows); the cast is contained here so typed call sites stay clean.
export function findInCacheById<TState, TItem>(
  entries: Iterable<[string, TState]>,
  id: string,
  getId: (item: TItem) => string,
): ProjectItemLookup<TItem> | null {
  for (const [project, state] of entries) {
    const list = state as unknown as TItem[];
    const idx = list.findIndex((item) => getId(item) === id);
    if (idx !== -1) return { project, list, idx, item: list[idx] };
  }
  return null;
}

export async function withItemAcrossProjectLists<TState, TItem, T>(
  entries: () => Iterable<[string, TState]>,
  id: string,
  getId: (item: TItem) => string,
  loadAllKnown: () => Promise<void>,
  fn: (lookup: ProjectItemLookup<TItem>) => T | Promise<T>,
): Promise<T | null> {
  const cached = findInCacheById<TState, TItem>(entries(), id, getId);
  if (cached) return fn(cached);
  await loadAllKnown();
  const loaded = findInCacheById<TState, TItem>(entries(), id, getId);
  if (loaded) return fn(loaded);
  return null;
}

export type LockedItemAcrossProjectListsOptions<TState, TItem, T> = {
  entries: () => Iterable<[string, TState]>;
  getState: (project: string) => TState | undefined;
  runProjectWrite: <TResult>(
    project: string,
    fn: () => TResult | Promise<TResult>,
  ) => Promise<TResult>;
  id: string;
  getId: (item: TItem) => string;
  loadAllKnown: () => Promise<void>;
  fn: (lookup: ProjectItemLookup<TItem>) => T | Promise<T>;
};

export async function withLockedItemAcrossProjectLists<
  TState,
  TItem,
  T,
>({
  entries,
  getState,
  runProjectWrite,
  id,
  getId,
  loadAllKnown,
  fn,
}: LockedItemAcrossProjectListsOptions<TState, TItem, T>): Promise<T | null> {
  let found = findInCacheById<TState, TItem>(entries(), id, getId);
  if (!found) {
    await loadAllKnown();
    found = findInCacheById<TState, TItem>(entries(), id, getId);
  }
  if (!found) return null;
  const project = found.project;
  return runProjectWrite<T | null>(project, () => {
    const list = getState(project) as unknown as TItem[] | undefined;
    if (!list) return null;
    const idx = list.findIndex((item) => getId(item) === id);
    if (idx === -1) return null;
    return fn({ project, list, idx, item: list[idx] });
  });
}
