import type { DirListing } from '../../api';

// Stale-response guard for the folder picker's directory navigation.
//
// Two quick navigations race: whichever `listDir` resolves LAST would otherwise
// win `setListing`/`setPathInput`. If a slower/deeper navigation resolves after
// a later one, the listing shown wouldn't match the path the user ended on, and
// selecting/creating a folder would operate against the wrong directory.
//
// We stamp each call with a monotonically increasing sequence id held in a ref
// and ignore any response that isn't the latest before touching state.
export type LoadDirectoryDeps = {
  listDir: (target?: string) => Promise<DirListing>;
  seqRef: { current: number };
  setLoading: (value: boolean) => void;
  setError: (value: string | null) => void;
  setSelectedPath: (value: string | null) => void;
  setListing: (value: DirListing) => void;
  setPathInput: (value: string) => void;
};

export async function loadDirectory(
  target: string | undefined,
  deps: LoadDirectoryDeps,
): Promise<void> {
  const seq = (deps.seqRef.current += 1);
  const isLatest = () => seq === deps.seqRef.current;

  deps.setLoading(true);
  deps.setError(null);
  // Navigating into a new folder clears any highlighted row (Windows-style).
  deps.setSelectedPath(null);
  try {
    const result = await deps.listDir(target);
    if (!isLatest()) return;
    deps.setListing(result);
    deps.setPathInput(result.path);
  } catch (err) {
    if (!isLatest()) return;
    deps.setError((err as Error).message);
  } finally {
    // Only the latest navigation clears the spinner — a stale response
    // resolving first must not flip `loading` off while the newest load is
    // still in flight.
    if (isLatest()) deps.setLoading(false);
  }
}
