import { useCallback, useEffect, useRef, useState } from 'react';
import { createDir, initProjectGit, listDir, type DirListing } from '../../api';
import { loadDirectory } from './loadDirectory';

export type FolderPickerState = {
  pathInput: string;
  setPathInput: (path: string) => void;
  listing: DirListing | null;
  selectedPath: string | null;
  setSelectedPath: (path: string | null) => void;
  newFolderName: string;
  setNewFolderName: (name: string) => void;
  initGit: boolean;
  setInitGit: (next: boolean) => void;
  loading: boolean;
  creating: boolean;
  error: string | null;
  /** Inline confirmation for the folder just created. */
  notice: string | null;
  load: (target?: string) => Promise<void>;
  createFolder: () => Promise<void>;
};

type UseFolderPickerStateArgs = {
  open: boolean;
  initialPath: string;
};

export function useFolderPickerState({ open, initialPath }: UseFolderPickerStateArgs): FolderPickerState {
  const [pathInput, setPathInput] = useState(initialPath);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  // Default on: a folder created here is the "start a new project" flow, and a
  // Lattice project that isn't a repo can't run a single task.
  const [initGit, setInitGit] = useState(true);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Monotonic request id so only the latest navigation updates state — stale
  // out-of-order listDir responses are ignored (see loadDirectory).
  const loadSeq = useRef(0);

  const load = useCallback((target?: string) => {
    // The confirmation belongs to the folder we just created; navigating away
    // from it makes the message stale.
    setNotice(null);
    return loadDirectory(target, {
      listDir,
      seqRef: loadSeq,
      setLoading,
      setError,
      setSelectedPath,
      setListing,
      setPathInput,
    });
  }, []);

  const createFolder = useCallback(async () => {
    if (!listing) return;
    const folderName = newFolderName.trim();
    if (!folderName) {
      setError('Enter a folder name.');
      return;
    }

    // Invalidate any directory load in flight by bumping the same seq the load
    // path uses: a slower listDir that resolves after this create can no longer
    // land its (now stale) listing on top of the just-created folder. Guard this
    // create's own writes too, so a newer navigation started mid-create wins.
    const seq = (loadSeq.current += 1);
    const isLatest = () => seq === loadSeq.current;

    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      // createDir returns the listing of the NEW folder, so the picker ends up
      // inside it and the footer's primary button already targets it.
      const result = await createDir(listing.path, folderName);
      if (!isLatest()) return;
      setListing(result);
      setPathInput(result.path);
      setNewFolderName('');
      if (!initGit) {
        setNotice(`Created ${folderName}.`);
        return;
      }
      // A folder that was just created is empty by definition, so this is the
      // zero-risk half of the git-setup contract: no preview, no dialog, and
      // nothing a first commit could accidentally capture.
      try {
        await initProjectGit(result.path);
        if (!isLatest()) return;
        setNotice(`Created ${folderName} and initialized a git repo.`);
      } catch (err) {
        if (!isLatest()) return;
        // The folder exists either way — say so, and report the git failure
        // separately rather than making it look like the create failed. The
        // backend forwards git's own stderr as `detail`; for a missing identity
        // that text is the only place the fix (two `git config` commands) is
        // spelled out, so it must reach the user rather than a bare summary.
        setNotice(`Created ${folderName}.`);
        const detail = (err as { detail?: unknown }).detail;
        setError(
          `Git setup failed: ${(err as Error).message}` +
            (typeof detail === 'string' && detail.trim() ? `\n${detail.trim()}` : ''),
        );
      }
    } catch (err) {
      if (!isLatest()) return;
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [initGit, listing, newFolderName]);

  useEffect(() => {
    if (open) load(initialPath);
  }, [open, initialPath, load]);

  return {
    pathInput,
    setPathInput,
    listing,
    selectedPath,
    setSelectedPath,
    newFolderName,
    setNewFolderName,
    initGit,
    setInitGit,
    loading,
    creating,
    error,
    notice,
    load,
    createFolder,
  };
}
