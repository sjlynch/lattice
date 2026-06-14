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
} from './agentOverlayConstants';
import { baseName } from './agentOverlayPathIndex';
import type { Agent } from './agentOverlayTypes';

const agentLabelCache = createLabelTextureCache();

// Build the label sprite for a file basename, in the agent color.
function buildAgentLabel(text: string, color: string, labelSize: number): THREE.Sprite {
  const tex = buildMeasuredLabelTexture(agentLabelCache, text, color, LABEL_OPTIONS);
  const label = makeFloatingLabelSprite(tex, labelSize, LABEL_SPRITE_CONFIG);
  label.renderOrder = LABEL_RENDER_ORDER;
  label.raycast = () => {}; // decorative — never a hover/pick target
  return label;
}

// Build/refresh the label sprite next to a node, showing its current file, and
// place it just to the right of and slightly above the node.
export function updateAgentLabel(
  group: THREE.Group,
  agent: Agent,
  labelSize: number,
  nodeSize: number,
): void {
  if (!agent.currentFile) return;
  const text = baseName(agent.currentFile);
  if (!agent.label || agent.labelText !== text) {
    if (agent.label) group.remove(agent.label);
    const label = buildAgentLabel(text, agent.color, labelSize);
    agent.label = label;
    agent.labelText = text;
    group.add(label);
  }
  agent.label.position.set(
    agent.pos.x + nodeSize * LABEL_OFFSET_X_FACTOR,
    agent.pos.y + nodeSize * LABEL_OFFSET_Y_FACTOR,
    agent.pos.z,
  );
}

// Drop the label (only reached before the agent's first activity, since the
// current file otherwise persists for the life of the session).
export function clearAgentLabel(group: THREE.Group, agent: Agent): void {
  if (agent.label) {
    group.remove(agent.label);
    agent.label = undefined;
  }
  agent.labelText = undefined;
  agent.currentFile = undefined;
}
