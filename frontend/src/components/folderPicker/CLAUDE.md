# frontend/src/components/folderPicker

Folder-picker internals used by the project chooser.

- Backend calls go through `loadDirectory.ts` (`/api/list-dir` and
  `/api/create-dir`); keep fetch/error shaping there.
- `useFolderPickerState.ts` owns navigation state, loading, root switching,
  create-folder flow, and selection callbacks.
- Presentational pieces (`DriveSelector`, `PathRow`, `DirectoryList`,
  `CreateFolderRow`) should stay dumb and callback-driven.
- Use `rootKey.ts` when deriving stable React keys for filesystem roots; drive
  letters and POSIX roots need normalization.
- Do not assume Windows-only paths despite Lattice's primary dev environment.
