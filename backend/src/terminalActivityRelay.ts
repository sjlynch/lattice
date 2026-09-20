import type { RawData } from 'ws';
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

// Cheap pre-test on the RAW frame bytes, before any string copy or JSON.parse:
// can this frame move the title parser? Only a `data` frame in the ground
// state is skippable; every other frame type (attached / exit / session_lost)
// is tiny and must be parsed. A data frame can carry a title only if its
// payload holds ESC (0x1b — which JSON.stringify always emits as the literal
// six characters `\u001b`) or a C1 control (U+0080–U+009F — UTF-8 `C2 80`…
// `C2 9F`). A payload containing the literal text `\u001b` is a false
// positive, which merely costs the full parse.
const DATA_FRAME_PREFIX = Buffer.from('{"type":"data","data":"');
const ESC_ESCAPE = Buffer.from('\\u001b');

export function rawDataFrameMayCarryTitle(frame: Buffer): boolean {
  if (frame.length < DATA_FRAME_PREFIX.length) return true;
  if (frame.compare(DATA_FRAME_PREFIX, 0, DATA_FRAME_PREFIX.length, 0, DATA_FRAME_PREFIX.length) !== 0) return true;
  if (frame.indexOf(ESC_ESCAPE) !== -1) return true;
  let i = frame.indexOf(0xc2);
  while (i !== -1 && i + 1 < frame.length) {
    const next = frame[i + 1]!;
    if (next >= 0x80 && next <= 0x9f) return true;
    i = frame.indexOf(0xc2, i + 1);
  }
  return false;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function createTerminalActivityRelayObserver(): {
  readonly sessionId: string | null;
  observe: (frame: string) => void;
  // `observe` over the raw WS frame: skips the string copy + JSON.parse for a
  // plain-output data frame that cannot change the title (see
  // rawDataFrameMayCarryTitle).
  observeRaw: (frame: RawData) => void;
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

  function observeRaw(frame: RawData): void {
    if (disposed) return;
    const buf = toBuffer(frame);
    // Once attached and in the ground state, plain output cannot change the
    // title — decided on the bytes, before the copy the string form costs.
    if (sessionId !== null && observation!.facts.isGround && !rawDataFrameMayCarryTitle(buf)) return;
    observe(buf.toString());
  }

  return { get sessionId() { return sessionId; }, observe, observeRaw, dispose };
}
