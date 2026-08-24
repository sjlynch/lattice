# frontend/src/components/folderPicker

Folder-picker internals used by the project chooser.

- Backend calls go through `loadDirectory.ts` (`/api/list-dir` and
  `/api/create-dir`); keep fetch/error shaping there.
- `useFolderPickerState.ts` owns navigation state, loading, root switching,
  create-folder flow, and selection callbacks. Create runs `createDir` →
  (when the "Initialize a git repo" checkbox is on, default) `initProjectGit` on
  the new path, and reports the outcome through `notice`. A folder that was just
  created is empty by definition, so this is the zero-risk half of the Git Setup
  contract — no preview, no dialog. A git failure sets `error` but keeps the
  `notice`, since the folder itself was created either way.
- Presentational pieces (`DriveSelector`, `PathRow`, `DirectoryList`,
  `CreateFolderRow`) should stay dumb and callback-driven.
- Use `rootKey.ts` when deriving stable React keys for filesystem roots; drive
  letters and POSIX roots need normalization.
- Do not assume Windows-only paths despite Lattice's primary dev environment.
