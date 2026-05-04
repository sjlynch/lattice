// Right-click menu items shown when a selection of nodes is right-clicked.
// Selecting an item opens a Modal pre-filled with the corresponding prompt.

export type MenuItemDef = {
  verb: string;
  label: string;
  prefill: string;
};

export const MENU_ITEMS: MenuItemDef[] = [
  {
    verb: 'Refactor',
    label: 'Refactor selection…',
    prefill:
      'Refactor the following files for clarity and maintainability while preserving existing behavior.\n\n' +
      'Focus on:\n' +
      '- Removing duplication and dead code (unused exports, parameters, branches).\n' +
      '- Renaming identifiers that no longer match what they do.\n' +
      '- Flattening deeply nested conditionals and breaking up overly long functions.\n' +
      '- Tightening types — replace `any`/loose unions with the narrowest accurate type.\n' +
      '- Aligning the code with patterns already used elsewhere in this codebase.\n\n' +
      'Constraints:\n' +
      '- Do not change public APIs, exported signatures, or wire formats unless explicitly requested.\n' +
      '- Do not introduce new abstractions, layers, or dependencies for hypothetical future reuse — three similar lines beat a premature abstraction.\n' +
      '- Keep the diff focused; do not reformat untouched code.\n' +
      '- Run the project\'s type-check (and tests, if quick) afterward and fix anything you broke.\n\n' +
      'Additional instructions: ',
  },
  {
    verb: 'Add tests',
    label: 'Add tests for selection…',
    prefill:
      "Write or expand tests for the following files using the project's existing test conventions.",
  },
  {
    verb: 'Document',
    label: 'Document selection…',
    prefill:
      'Add or improve docstrings/inline comments for these files. Keep comments minimal and only where the WHY is non-obvious.',
  },
  {
    verb: 'Find dead code',
    label: 'Find dead code…',
    prefill:
      'Identify and report any unused exports/functions/variables in these files.',
  },
];

// Convert an absolute path to a slash-style path relative to `root`.
// Used in the modal so file lists render readably regardless of OS.
export function relPath(full: string, root: string): string {
  if (!root) return full.replace(/\\/g, '/');
  const r = root.replace(/[\\/]+$/, '');
  if (full.startsWith(r)) {
    return full.slice(r.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  }
  return full.replace(/\\/g, '/');
}
