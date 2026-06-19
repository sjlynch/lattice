// Agent file-label management: the camera-scaled sprite next to each node
// showing the basename it most recently read/edited. Owns the texture cache
// and the build/update/clear lifecycle; reuses labelTexture + floatingLabelSprite
// so agent labels read at the same scale as the Alt-label overlay's file labels.

import type * as THREE from 'three';
import { makeFloatingLabelSprite } from './floatingLabelSprite';
import { buildMeasuredLabelTexture, createLabelTextureCache } from './labelTexture';
import {
  LABEL_OFFSET_X_FACTOR,
  LABEL_OFFSET_Y_FACTOR,
  LABEL_OPTIONS,
  LABEL_RENDER_ORDER,
  LABEL_SPRITE_CONFIG,
  SATELLITE_LABEL_OFFSET_X_FACTOR,
  SATELLITE_LABEL_OFFSET_Y_FACTOR,
  SATELLITE_LABEL_SCALE,
} from './agentOverlayConstants';
import { baseName } from './agentOverlayPathIndex';
import type { Agent, LabelHost, Satellite } from './agentOverlayTypes';

const agentLabelCache = createLabelTextureCache();

// Build the label sprite for a file basename, in the agent color.
function buildAgentLabel(text: string, color: string, labelSize: number): THREE.Sprite {
  const tex = buildMeasuredLabelTexture(agentLabelCache, text, color, LABEL_OPTIONS);
  const label = makeFloatingLabelSprite(tex, labelSize, LABEL_SPRITE_CONFIG);
  label.renderOrder = LABEL_RENDER_ORDER;
  label.raycast = () => {}; // decorative — never a hover/pick target
  return label;
}

// Build/refresh a host's label sprite to `text` and place it at
// (anchor + nodeSize * offset). Shared by agent file-labels and satellite
// type-labels. Skips the `position.set` when neither the anchor nor nodeSize
// changed since last call (and the sprite wasn't just rebuilt to a default
// position) — once a host settles its label stops moving, so this is a no-op
// every idle frame otherwise (Part D).
function applyFloatingLabel(
  group: THREE.Group,
  host: LabelHost,
  text: string,
  anchor: THREE.Vector3,
  labelSize: number,
  nodeSize: number,
  offXFactor: number,
  offYFactor: number,
): void {
  let rebuilt = false;
  if (!host.label || host.labelText !== text) {
    if (host.label) group.remove(host.label);
    const label = buildAgentLabel(text, host.color, labelSize);
    host.label = label;
    host.labelText = text;
    group.add(label);
    rebuilt = true;
  }
  if (
    !rebuilt &&
    host.labelPosX === anchor.x &&
    host.labelPosY === anchor.y &&
    host.labelPosZ === anchor.z &&
    host.labelNodeSize === nodeSize
  ) {
    return;
  }
  host.label.position.set(
    anchor.x + nodeSize * offXFactor,
    anchor.y + nodeSize * offYFactor,
    anchor.z,
  );
  host.labelPosX = anchor.x;
  host.labelPosY = anchor.y;
  host.labelPosZ = anchor.z;
  host.labelNodeSize = nodeSize;
}

function removeFloatingLabel(group: THREE.Group, host: LabelHost): void {
  if (host.label) {
    group.remove(host.label);
    host.label = undefined;
  }
  host.labelText = undefined;
}

// Build/refresh the label sprite next to an agent node, showing its current
// file, just to the right of and slightly above the node.
export function updateAgentLabel(
  group: THREE.Group,
  agent: Agent,
  labelSize: number,
  nodeSize: number,
): void {
  if (!agent.currentFile) return;
  // Use the basename cached at the write site (applyActivity); fall back to a
  // recompute only if it's somehow absent. Avoids a regex replace + slice each
  // frame purely to compare against the existing label text.
  applyFloatingLabel(
    group,
    agent,
    agent.currentFileBase ?? baseName(agent.currentFile),
    agent.pos,
    labelSize,
    nodeSize,
    LABEL_OFFSET_X_FACTOR,
    LABEL_OFFSET_Y_FACTOR,
  );
}

// Drop the agent's label (only reached before its first activity, since the
// current file otherwise persists for the life of the session).
export function clearAgentLabel(group: THREE.Group, agent: Agent): void {
  removeFloatingLabel(group, agent);
  agent.currentFile = undefined;
  agent.currentFileBase = undefined;
}

// Build/refresh a satellite's type label (e.g. 'Explore'), reading smaller than
// the parent's file label and tucked just under the satellite node.
export function updateSatelliteLabel(
  group: THREE.Group,
  satellite: Satellite,
  labelSize: number,
  nodeSize: number,
): void {
  applyFloatingLabel(
    group,
    satellite,
    satellite.subagentType || 'subagent',
    satellite.pos,
    labelSize * SATELLITE_LABEL_SCALE,
    nodeSize,
    SATELLITE_LABEL_OFFSET_X_FACTOR,
    SATELLITE_LABEL_OFFSET_Y_FACTOR,
  );
}
