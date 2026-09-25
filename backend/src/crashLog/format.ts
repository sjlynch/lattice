// Text formatting shared by the crash file, the live mirror and the console
// tee: argument/error rendering, the memory line, and the filename timestamp.
// Pure helpers — nothing here touches the filesystem.

// Width of the zero-padded per-process counter in a crash filename, so names
// written in the same millisecond still sort chronologically.
export const CRASH_SEQ_WIDTH = 3;

export function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

export function describe(errOrReason: unknown): string {
  if (errOrReason instanceof Error) {
    const extra = Object.entries(errOrReason)
      .filter(([k]) => !['message', 'stack'].includes(k))
      .map(([k, v]) => `  ${k}: ${formatArg(v)}`)
      .join('\n');
    return `${errOrReason.stack ?? `${errOrReason.name}: ${errOrReason.message}`}${
      extra ? `\n${extra}` : ''
    }`;
  }
  return formatArg(errOrReason);
}

function mb(n: number): string {
  return `${Math.round(n / 1024 / 1024)}MB`;
}

// The `memory:` line body. The crash file also reports heapTotal; the live
// mirror's header, rewritten every couple of seconds, keeps it short.
export function memSummary(
  mem: NodeJS.MemoryUsage,
  opts: { heapTotal?: boolean } = {},
): string {
  const base = `rss ${mb(mem.rss)}, heapUsed ${mb(mem.heapUsed)}`;
  return opts.heapTotal ? `${base}, heapTotal ${mb(mem.heapTotal)}` : base;
}

// ISO timestamp made filename-safe. It leads every crash filename, so a
// lexicographic sort of those names is chronological (see retention.ts).
export function fileTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
