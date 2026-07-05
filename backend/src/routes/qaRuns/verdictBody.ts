// Tolerantly read a PASS/confident verdict out of the agent's POST body. The
// brief tells it to send `{ "verdict": "pass"|"fail", "confidence": "high"|"low" }`,
// but we also accept the boolean shorthand (`passed` / `confident`) so a small
// wording drift in a user-edited QA template still advances the task.
export function parseVerdictBody(
  body: unknown,
): { passed: boolean; confident: boolean } {
  const b = (body || {}) as {
    verdict?: unknown;
    confidence?: unknown;
    passed?: unknown;
    confident?: unknown;
  };
  const verdict = typeof b.verdict === 'string' ? b.verdict.trim().toLowerCase() : '';
  const confidence =
    typeof b.confidence === 'string' ? b.confidence.trim().toLowerCase() : '';
  const passed = b.passed === true || verdict === 'pass' || verdict === 'passed';
  const confident = b.confident === true || confidence === 'high';
  return { passed, confident };
}
