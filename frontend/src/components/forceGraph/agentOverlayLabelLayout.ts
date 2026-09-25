// The APL **label spreader**: places every agent file label and satellite file
// label beside its node, then pushes labels apart in SCREEN space so the text of
// a busy cluster (a parent + several subagents reading files at once, or two
// agents working in the same region) never overlaps.
//
// Why screen space: the labels are camera-facing sprites and the camera orbits,
// so whether two labels collide depends on the view. Each frame the overlay
// ticks (only while the render loop runs — see the APL idle contract) the
// anchors are projected onto the camera's image plane, laid out there by the
// pure `spreadLabelRects`, and the result is mapped back to a world position at
// each anchor's own depth. The layout is a snap, not an animation, so it never
// holds the idle controller: a settled scene stays settled, and an orbit (which
// already renders on the `interact` reason) re-lays the labels out for free.
//
// A label that had to move well away from the spot beside its node gets a
// faint leader line back to its node, so it still reads as belonging to it.

import * as THREE from 'three';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { AgentOverlayCtx } from './agentOverlayContext';
import {
  LABEL_SPRITE_CONFIG,
  LEADER_MIN_SHIFT_FACTOR,
  LEADER_OPACITY,
  SPREAD_LABEL_GAP_FACTOR,
  SPREAD_LABEL_PAD_X,
  SPREAD_LABEL_PAD_Y,
  SPREAD_PARENT_DY_FACTOR,
  SPREAD_SATELLITE_GAP_FACTOR,
} from './agentOverlayConstants';
import { createLeader, updateBeamEndpoints } from './agentOverlayBeams';
import { floatingLabelHeight } from './floatingLabelSprite';
import type { LabelHost } from './agentOverlayTypes';

// One label to place, in image-plane units (world units divided by depth, so
// every item is measured on the same scale regardless of how far it is).
export type LabelRectInput = {
  // Anchor (the node the label belongs to).
  ax: number;
  ay: number;
  // Label size.
  w: number;
  h: number;
  // Which side of the node the label sits on: 1 = right, -1 = left.
  side: 1 | -1;
  // Horizontal gap between the node centre and the label's near edge.
  gap: number;
  // Preferred vertical offset of the label centre from the anchor.
  dy: number;
};

export type LabelRectOutput = { cx: number; cy: number };

// Greedy, deterministic de-overlap: labels are placed top-down (by preferred
// centre Y, ties by input order) at their preferred spot beside their node; one
// that overlaps an already-placed label is pushed to just below it, re-checked
// against every placed label until it is clear. Horizontal position never
// changes — labels only slide along their node's side, so each stays next to
// its own orb. `padX`/`padY` are the minimum clearances. Pure — unit-tested.
// Relative slack in the overlap test (fraction of the two labels' heights).
const SEPARATION_TOLERANCE = 1e-6;

export function spreadLabelRects(
  items: readonly LabelRectInput[],
  padX: number,
  padY: number,
): LabelRectOutput[] {
  const out: LabelRectOutput[] = items.map((it) => ({
    cx: it.ax + it.side * (it.gap + it.w / 2),
    cy: it.ay + it.dy,
  }));
  const order = items
    .map((_, i) => i)
    .sort((a, b) => out[b].cy - out[a].cy || a - b);
  const placed: number[] = [];
  for (const i of order) {
    const it = items[i];
    const o = out[i];
    // Every push moves strictly below a placed label, so this terminates in at
    // most `placed.length` pushes; the cap is belt-and-braces.
    for (let guard = 0; guard <= placed.length; guard++) {
      let hit = -1;
      for (const j of placed) {
        const p = out[j];
        const q = items[j];
        // The tolerance matters: a label just pushed below `p` sits exactly on
        // the separation boundary, and float rounding (0.3 - 2 - 0.2) can read
        // that as still overlapping — every retry then re-pushed it to the same
        // spot under `p`, the guard ran out, and it was never checked against
        // the label already sitting there, so the two were drawn on top of
        // each other.
        const tol = SEPARATION_TOLERANCE * (it.h + q.h);
        if (
          Math.abs(o.cx - p.cx) < (it.w + q.w) / 2 + padX - tol &&
          Math.abs(o.cy - p.cy) < (it.h + q.h) / 2 + padY - tol
        ) {
          hit = j;
          break;
        }
      }
      if (hit < 0) break;
      o.cy = out[hit].cy - (items[hit].h + it.h) / 2 - padY;
    }
    placed.push(i);
  }
  return out;
}

// Scratch reused across frames (the tick is not re-entrant).
const camPos = new THREE.Vector3();
const right = new THREE.Vector3();
const up = new THREE.Vector3();
const fwd = new THREE.Vector3();
const rel = new THREE.Vector3();
const target = new THREE.Vector3();
const leaderEnd = new THREE.Vector3();

type Placed = {
  host: LabelHost;
  anchor: THREE.Vector3;
  depth: number;
};

// Positions below this depth (in front of the near plane / behind the camera)
// can't be projected meaningfully — those labels keep their fallback spot.
const MIN_DEPTH = 1e-3;
// Label positions are only re-set when they moved at least this far (world
// units), so a settled scene doesn't re-dirty sprite matrices every frame.
const POS_EPS = 0.01;

function cameraOf(graph: ForceGraph3DInstance): THREE.Camera | null {
  const cam = (graph as unknown as { camera?: () => THREE.Camera }).camera?.();
  return cam ?? null;
}

// Lay out every visible agent + satellite label for this frame. Called at the
// end of the overlay tick, after each host's label text/size has been updated.
export function layoutAgentLabels(
  ctx: AgentOverlayCtx,
  graph: ForceGraph3DInstance,
): void {
  const camera = cameraOf(graph);
  if (!camera) return;
  camPos.setFromMatrixPosition(camera.matrixWorld);
  right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  fwd.setFromMatrixColumn(camera.matrixWorld, 2).normalize().negate();

  const hosts: Placed[] = [];
  const items: LabelRectInput[] = [];
  const nodeSize = ctx.nodeSize;

  const push = (
    host: LabelHost,
    anchor: THREE.Vector3,
    side: 1 | -1,
    gapWorld: number,
    dyWorld: number,
  ): void => {
    const label = host.label;
    if (!label || host.labelSizeAtBuild === undefined) return;
    rel.subVectors(anchor, camPos);
    const depth = rel.dot(fwd);
    if (depth < MIN_DEPTH) return;
    // The sprite rescales itself in its own onBeforeRender, which runs AFTER
    // this (scene-level) pass — so compute the height it WILL have this frame
    // instead of reading last frame's scale.
    const hWorld = floatingLabelHeight(
      rel.length(),
      host.labelSizeAtBuild,
      LABEL_SPRITE_CONFIG,
    );
    const aspect = label.scale.y > 0 ? label.scale.x / label.scale.y : 1;
    items.push({
      ax: rel.dot(right) / depth,
      ay: rel.dot(up) / depth,
      w: (hWorld * aspect) / depth,
      h: hWorld / depth,
      side,
      gap: gapWorld / depth,
      dy: dyWorld / depth,
    });
    hosts.push({ host, anchor, depth });
  };

  for (const agent of ctx.agents.values()) {
    push(
      agent,
      agent.pos,
      1,
      nodeSize * SPREAD_LABEL_GAP_FACTOR,
      nodeSize * SPREAD_PARENT_DY_FACTOR,
    );
    for (const sat of agent.satellites.values()) {
      // Fan satellite labels outward: a satellite left of its parent on screen
      // labels to its left, so the cluster's labels don't all pile up on one
      // side of the parent.
      rel.subVectors(sat.pos, agent.pos);
      const side: 1 | -1 = rel.dot(right) < 0 ? -1 : 1;
      push(sat, sat.pos, side, nodeSize * SPREAD_SATELLITE_GAP_FACTOR, 0);
    }
  }
  if (items.length === 0) return;

  // Paddings are image-plane units; scale them by a typical label height so
  // they read as a fraction of a line regardless of zoom.
  let meanH = 0;
  for (const it of items) meanH += it.h;
  meanH /= items.length;
  const placed = spreadLabelRects(
    items,
    meanH * SPREAD_LABEL_PAD_X,
    meanH * SPREAD_LABEL_PAD_Y,
  );

  for (let i = 0; i < items.length; i++) {
    const { host, anchor, depth } = hosts[i];
    const it = items[i];
    const o = placed[i];
    const dx = (o.cx - it.ax) * depth;
    const dy = (o.cy - it.ay) * depth;
    target.copy(anchor).addScaledVector(right, dx).addScaledVector(up, dy);
    const label = host.label!;
    if (label.position.distanceToSquared(target) > POS_EPS * POS_EPS) {
      label.position.copy(target);
    }
    // Leader line when the spreader moved the label off its preferred row.
    const shift = Math.abs(o.cy - (it.ay + it.dy));
    if (shift > it.h * LEADER_MIN_SHIFT_FACTOR) {
      if (!host.leader) {
        host.leader = createLeader(host.color, LEADER_OPACITY);
        ctx.group.add(host.leader.line);
      }
      // End at the label's near edge, level with its centre.
      leaderEnd
        .copy(target)
        .addScaledVector(right, -it.side * (it.w / 2) * depth);
      updateBeamEndpoints(host.leader, anchor, leaderEnd);
      host.leader.line.visible = true;
    } else if (host.leader) {
      host.leader.line.visible = false;
    }
  }
}
