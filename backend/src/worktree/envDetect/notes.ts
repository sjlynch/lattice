import type { DetectedEnv } from './detectors.js';

export type EnvNoteInfo = DetectedEnv & {
  /** The built-in note Lattice would inject for this env. */
  defaultNote: string;
  /**
   * What actually gets injected: the user's override if they set one in
   * `UserSettings.worktreeEnvNotes`, else `defaultNote`. An empty string
   * means the user suppressed the note for this env.
   */
  effectiveNote: string;
};

// The built-in note for a detected env. Single paragraph, no internal
// newlines — so it composes cleanly into a markdown blockquote.
export function defaultEnvNote(env: DetectedEnv): string {
  const dir = env.heavyDir.replace(/\\/g, '/');
  return (
    `**Heads up — fresh worktree (${env.label}).** This task runs in a throwaway git ` +
    `worktree. \`${dir}/\` is gitignored, so it is **not** checked out here. Editing code ` +
    `doesn't need installed dependencies, and you won't run tests, builds or type-checks ` +
    `here (a separate Run tests step verifies merged work) — **skip \`${env.installCmd}\`.** ` +
    `The one exception: if your instructions allow a type-check of what you edited, run ` +
    `that command once first and move on.`
  );
}

// Render a list of env notes as a markdown blockquote callout (or '' when
// there are none). Built-in notes are single-paragraph, but a user override
// can contain newlines — every line gets a `> ` prefix so the blockquote
// stays well-formed; a blank `>` line separates consecutive notes.
export function renderEnvNotesBlock(notes: string[]): string {
  const cleaned = notes.map((n) => n.trim()).filter((n) => n.length > 0);
  if (cleaned.length === 0) return '';
  const quoted = cleaned
    .map((note) =>
      note
        .split('\n')
        .map((line) => (line.length > 0 ? `> ${line}` : '>'))
        .join('\n'),
    )
    .join('\n>\n');
  return `${quoted}\n\n`;
}
