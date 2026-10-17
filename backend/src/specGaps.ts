import type { Task } from './tasks.js';
import type { RecentSpecGap } from './specGapsTypes.js';

export type { RecentSpecGap } from './specGapsTypes.js';

const BULLET = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/;

function markerValue(line: string): string | null {
  // Markdown prefixes can nest: `- **Spec gaps:**`, `### __Spec gaps__`.
  let text = line.trim();
  const wrappers: string[] = [];
  let previous: string;
  do {
    previous = text;
    text = text.replace(/^(?:#+\s*|(?:[-*+]|\d+\.)\s+)/, '').trim();
    const emphasis = /^(\*\*|__)/.exec(text)?.[1];
    if (emphasis) {
      wrappers.push(emphasis);
      text = text.slice(emphasis.length).trim();
    }
  } while (text !== previous);
  const match = /^spec gaps(?=$|\s|:|\*\*|__)(.*)$/i.exec(text);
  if (!match) return null;
  let value = match[1].trim();
  for (const emphasis of wrappers.reverse()) {
    if (value.startsWith(emphasis)) value = value.slice(emphasis.length).trim();
    else if (value.startsWith(':') && value.slice(1).trimStart().startsWith(emphasis)) {
      value = ':' + value.slice(1).trimStart().slice(emphasis.length);
    } else if (value.endsWith(emphasis)) value = value.slice(0, -emphasis.length).trim();
  }
  return value.replace(/^:\s*/, '').trim();
}

function cleanItem(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > 300 ? cleaned.slice(0, 299) + '…' : cleaned;
}

export function parseSpecGaps(summary: string): string[] {
  const lines = summary.split(/\r?\n/);
  let marker = -1;
  let inline = '';
  for (let i = 0; i < lines.length; i++) {
    const value = markerValue(lines[i]);
    if (value !== null) {
      marker = i;
      inline = value;
    }
  }
  if (marker < 0 || /^(?:none|n\/a|nothing)\.?$/i.test(inline)) return [];

  const items: string[] = [];
  let blank = false;
  for (let i = marker + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      if (blank) break;
      blank = true;
      continue;
    }
    if (/^\s*(?:#|---\s*$)/.test(line)) break;
    const bullet = BULLET.exec(line);
    if (bullet) {
      items.push(bullet[1]);
      blank = false;
    } else if (!blank && items.length && /^\s+\S/.test(line)) {
      items[items.length - 1] += ' ' + line.trim();
    } else {
      break;
    }
  }
  return (items.length ? items : [inline]).map(cleanItem).filter(Boolean);
}

export function recentSpecGaps(
  tasks: readonly Task[],
  opts: { limit?: number; now?: number; maxAgeDays?: number } = {},
): RecentSpecGap[] {
  const { limit = 25, now = Date.now(), maxAgeDays = 60 } = opts;
  if (limit <= 0) return [];
  const cutoff = now - maxAgeDays * 86_400_000;
  const entries: RecentSpecGap[] = [];
  for (const task of tasks) {
    if (task.status === 'deleted' || typeof task.summary !== 'string' || !task.summary.trim()) continue;
    const times = [task.doneAt, task.mergedAt, task.completedAt, task.updatedAt, task.createdAt]
      .filter((at): at is number => typeof at === 'number' && Number.isFinite(at));
    if (!times.length) continue;
    const at = Math.max(...times);
    if (at < cutoff) continue;
    for (const gap of parseSpecGaps(task.summary)) {
      entries.push({ taskId: task.id, title: task.title, gap, at });
    }
  }
  entries.sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  return entries.filter(({ gap }) => {
    const key = gap.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

export function renderTaskWritingGuidance(rules: readonly string[], gaps: readonly RecentSpecGap[]): string {
  const blocks: string[] = [];
  if (rules.length) {
    blocks.push('**Rules for task descriptions in this project:**\n\n' + rules.map((rule) => `- ${rule}`).join('\n'));
  }
  if (gaps.length) {
    blocks.push('**What implementers here recently had to decide themselves** (the task they ran did not say; state these kinds of decisions in the tasks you file):\n\n' +
      gaps.slice(0, 15).map(({ gap, title }) => {
        const shortTitle = title.length > 80 ? title.slice(0, 79) + '…' : title;
        return `- ${gap} (task "${shortTitle}")`;
      }).join('\n'));
  }
  return blocks.length ? blocks.join('\n\n').replace(/\n+$/, '') + '\n\n' : '';
}
