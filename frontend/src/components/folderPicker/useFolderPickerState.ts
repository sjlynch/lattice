import { useCallback, useEffect, useState } from 'react';
import { createDir, listDir, type DirListing } from '../../api';

export type FolderPickerState = {
  pathInput: string;
  setPathInput: (path: string) => void;
  listing: DirListing | null;
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
  const [newFolderName, setNewFolderName] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (target?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await listDir(target);
      setListing(result);
      setPathInput(result.path);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const createFolder = useCallback(async () => {
    if (!listing) return;
    const folderName = newFolderName.trim();
    if (!folderName) {
      setError('Enter a folder name.');
      return;
    }

    setCreating(true);
    setError(null);
    try {
      const result = await createDir(listing.path, folderName);
      setListing(result);
      setPathInput(result.path);
      setNewFolderName('');
    } catch (err) {
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
    newFolderName,
    setNewFolderName,
    loading,
    creating,
    error,
    load,
    createFolder,
  };
}
