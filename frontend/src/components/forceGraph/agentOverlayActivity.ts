// Focus-beam add/demote *policy* for the Agent Presence Layer — the rule for
// which touched files stay lit and which fade. Shared by the main agent and its
// satellites (both are `BeamHost`s). The beam three.js lifecycle lives in
// agentOverlayBeams.ts; the per-frame geometry passes live in
// agentOverlayBeamMath.ts.

import type { AgentOverlayCtx } from './agentOverlayContext';
import { BEAM_END_FADE_MS, BEAM_TTL_MS } from './agentOverlayConstants';
import { baseName, normalizePath } from './agentOverlayPathIndex';
import { createBeam, disposeExpiredBeams } from './agentOverlayBeams';
import type { Beam } from './agentOverlayTypes';

// The beam-bearing fields shared by an Agent and a Satellite, so the focus-beam
// add/demote policy (`applyActivity`) works on either.
export type BeamHost = {
  color: string;
  beams: Map<string, Beam>;
  currentFile?: string;
  // Cached basename of currentFile (kept in lock-step at the write site below).
  currentFileBase?: string;
};

// Focus-beam add/demote policy, shared by the main agent and its satellites.
// The current file's beam is kept persistent (`endAt = Infinity`) so the last
// file the host viewed/edited stays lit until either a *new* file is touched
// (demoting the old one to a fading TTL beam) or the host is removed. A
// PostToolUse (`end`) for the current file does NOT fade it.
export function applyActivity(
  ctx: AgentOverlayCtx,
  host: BeamHost,
  file: string,
  phase: 'start' | 'end',
  now: number,
): void {
  const norm = normalizePath(file);
  const prevNorm = host.currentFile ? normalizePath(host.currentFile) : null;

  if (phase === 'end') {
    // Tool finished. Keep the current (last-touched) file lit; only let an
    // older, no-longer-current file begin to fade.
    const existing = host.beams.get(norm);
    if (existing && norm !== prevNorm) {
      existing.endAt = Math.min(existing.endAt, now + BEAM_END_FADE_MS);
    }
    return;
  }

  // phase === 'start': this file becomes the host's current file. Demote the
  // previously-current file's beam to a normal fading one.
  if (prevNorm && prevNorm !== norm) {
    const prevBeam = host.beams.get(prevNorm);
    if (prevBeam) prevBeam.endAt = now + BEAM_TTL_MS;
  }
  host.currentFile = file;
  host.currentFileBase = baseName(file);

  const existing = host.beams.get(norm);
  if (existing) {
    existing.endAt = Infinity;
    return;
  }
  // Release expired beams before adding one: the per-frame prune never runs
  // while the render loop is paused (hidden tab / collapsed graph), so this
  // keeps the beam map bounded by what's actually lit.
  disposeExpiredBeams(ctx.group, host.beams, now);
  const beam = createBeam(host.color, norm, now);
  host.beams.set(norm, beam);
  ctx.group.add(beam.line);
}
