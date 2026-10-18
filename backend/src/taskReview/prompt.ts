export type ReviewReply = { verdict: 'accept' | 'reject'; p: number; reason: string };
export type ReviewFile = { path: string; diff: string; before: string; test: boolean };

export function isReviewTestFile(file: string): boolean {
  return /(^|\/)(__tests__|tests?|specs?|e2e|fixtures)(\/|$)|[._-](test|spec)\.[^/]+$/i.test(file);
}

export function renderReviewPrompt(title: string, description: string, files: ReviewFile[]): string {
  const diff = [...files.filter((file) => !file.test), ...files.filter((file) => file.test)]
    .map((file) => file.diff).join('\n').slice(0, 12_000);
  const before = files.filter((file) => !file.test)
    .map((file) => `${file.path}:\n${file.before}`).join('\n\n').slice(0, 14_000);
  return `You review a coding agent's change before it is merged. You cannot run anything.

TASK the agent was given:
${title}

${description}

AGENT PATCH:
${diff}

PRE-PATCH SOURCE of the files it touched:
${before}

Predict whether this patch fully resolves the task: would regression tests that a maintainer writes for this task pass? Consider missed cases, wrong layer, partial fixes, and behavior the task implies but the patch ignores.
Answer ONLY JSON: {"p": <0-100 probability the patch is correct and complete>, "verdict": "accept" | "reject", "reason": "<= 20 words"}`;
}

// Locate the FIRST balanced object; braces inside quoted reasons are text.
// Invalid first objects must not be rescued by a later, different verdict.
export function parseReviewReply(text: string): ReviewReply | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        const reply = JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
        if ((reply.verdict !== 'accept' && reply.verdict !== 'reject') ||
            typeof reply.p !== 'number' || !Number.isFinite(reply.p) || reply.p < 0 || reply.p > 100 ||
            typeof reply.reason !== 'string') return null;
        return { verdict: reply.verdict, p: reply.p, reason: reply.reason.slice(0, 300) };
      } catch { return null; }
    }
  }
  return null;
}
