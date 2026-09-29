// Per-policy cache for the backend's lock-holder report. The policy decides
// when to probe and how to act on the answer on a later poll.
export function createParkedProbeCache({ now, queryLockHolders, ttlMs }) {
  let parkedProbe = null; // { key, at, report }
  let parkedProbeInFlight = false;

  function lockSetKey(locks) {
    return locks.map((lock) => `${lock.hash}:${lock.pid}:${lock.startedAt}`).sort().join('|');
  }

  // The cached parked answer for exactly this lock set, if fresh; else null.
  function freshReport(locks) {
    if (!parkedProbe) return null;
    if (parkedProbe.key !== lockSetKey(locks)) return null;
    if (now() - parkedProbe.at >= ttlMs) return null;
    return parkedProbe.report;
  }

  function start(locks) {
    // One query at a time, even if another lock set is seen while it awaits.
    if (parkedProbeInFlight || !queryLockHolders) return;
    parkedProbeInFlight = true;
    const key = lockSetKey(locks);
    Promise.resolve()
      .then(() => queryLockHolders())
      .then(
        (report) => report,
        (err) => ({ ok: false, why: `lock-holder query threw: ${err?.message ?? err}` }),
      )
      .then((report) => {
        parkedProbeInFlight = false;
        // Freshness starts when the answer arrives, for the original lock set.
        parkedProbe = { key, at: now(), report: report ?? { ok: false, why: 'no answer' } };
      });
  }

  // During a parked hold, refresh halfway through the answer's lifetime.
  function refreshIfDue(locks) {
    if (now() - (parkedProbe?.at ?? 0) >= ttlMs / 2) start(locks);
  }

  return { freshReport, start, refreshIfDue };
}
