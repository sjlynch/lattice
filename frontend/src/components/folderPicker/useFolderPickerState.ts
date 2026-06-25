import { useCallback, useEffect, useRef, useState } from 'react';
import { createDir, listDir, type DirListing } from '../../api';
import { loadDirectory } from './loadDirectory';

export type FolderPickerState = {
  pathInput: string;
  setPathInput: (path: string) => void;
  listing: DirListing | null;
  selectedPath: string | null;
  setSelectedPath: (path: string | null) => void;
  newFolderName: string;
  setNewFolderName: (name: string) => void;
  loading: boolean;
  creating: boolean;
  error: string | null;
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
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic request id so only the latest navigation updates state — stale
  // out-of-order listDir responses are ignored (see loadDirectory).
  const loadSeq = useRef(0);

  const load = useCallback(
    (target?: string) =>
      loadDirectory(target, {
        listDir,
        seqRef: loadSeq,
        setLoading,
        setError,
        setSelectedPath,
        setListing,
        setPathInput,
      }),
    [],
  );

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
    try {
      const result = await createDir(listing.path, folderName);
      if (!isLatest()) return;
      setListing(result);
      setPathInput(result.path);
      setNewFolderName('');
    } catch (err) {
      if (!isLatest()) return;
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [listing, newFolderName]);

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
    loading,
    creating,
    error,
    load,
    createFolder,
  };
}
