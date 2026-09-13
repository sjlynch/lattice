import { TerminalOutputFacts } from './terminal/outputFacts.js';

type Observation = { facts: TerminalOutputFacts };
const observations = new Map<string, Set<Observation>>();
const ESCAPE_OR_C1 = /[\x1b\x80-\x9f]/;

// A compatibility fact for retained executors that do not publish a native
// terminalTitle yet. The oldest live viewer owns the fact; each viewer keeps
// its own parser so duplicate, differently chunked streams cannot interleave.
export function getObservedTerminalTitle(id: string): string | null | undefined {
  return observations.get(id)?.values().next().value?.facts.terminalTitle;
}

export function createTerminalActivityRelayObserver(): {
  readonly sessionId: string | null;
  observe: (frame: string) => void;
  dispose: () => void;
} {
  let sessionId: string | null = null;
  let observation: Observation | null = null;
  let disposed = false;

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (sessionId !== null && observation !== null) {
      const entries = observations.get(sessionId);
      entries?.delete(observation);
      if (entries?.size === 0) observations.delete(sessionId);
    }
    observation = null;
  }

  function observe(frame: string): void {
    if (disposed) return;
    let msg: { type?: unknown; id?: unknown; data?: unknown } | null;
    try { msg = JSON.parse(frame); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'exit' || msg.type === 'session_lost') {
      dispose();
      return;
    }
    if (sessionId === null) {
      // The request's id is not evidence of a successful attach. Only the
      // executor handshake may register an observation, including new PTYs.
      if (msg.type !== 'attached' || typeof msg.id !== 'string' || !msg.id) return;
      sessionId = msg.id;
      observation = { facts: new TerminalOutputFacts() };
      let entries = observations.get(sessionId);
      if (!entries) observations.set(sessionId, entries = new Set());
      entries.add(observation);
    } else if (msg.type === 'data' && typeof msg.data === 'string') {
      // Scrollback and live output share one envelope. Replay's final title is
      // useful state, but its old output must never receive a fresh timestamp.
      // The parser stores only a bounded title and incremental escape state.
      const facts = observation!.facts;
      // Plain output cannot change a title from the ground state. This avoids
      // a per-character scan of large log replays; a pending escape still
      // consumes every chunk, including a title split before its plain text.
      if (!facts.isGround || ESCAPE_OR_C1.test(msg.data)) facts.write(msg.data, 0);
    }
  }

  return { get sessionId() { return sessionId; }, observe, dispose };
}
