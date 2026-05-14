// Parse a markdown body into a list of {title, description?} tasks. Each
// `# ` heading starts a new task; lines below it (until the next heading)
// are the description. Lines before the first heading are ignored.
//
// Why this exists: building a JSON array of tasks with multi-line
// descriptions in a shell is brutal — every backslash, quote, and
// newline needs escaping. A heredoc with single-quoted EOF passes
// markdown through *literally*, no escaping at all. This is the
// difference between a 5-line curl invocation and a 300-line python
// script when an agent wants to seed many tasks at once.
export function parseMarkdownTasks(md: string): Array<{ title: string; description?: string }> {
  const lines = md.split(/\r?\n/);
  const out: Array<{ title: string; description: string[] }> = [];
  let current: { title: string; description: string[] } | null = null;
  for (const line of lines) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) out.push(current);
      current = { title: heading[1], description: [] };
    } else if (current) {
      current.description.push(line);
    }
    // pre-heading lines are dropped intentionally
  }
  if (current) out.push(current);
  return out
    .filter((t) => t.title.trim())
    .map((t) => {
      const desc = t.description.join('\n').trim();
      return desc ? { title: t.title, description: desc } : { title: t.title };
    });
}
