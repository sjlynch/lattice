// Stable public facade for Pi graph-activity reporting.
// Rendering, installation and the filename live in piActivity/.
// See piActivity/CLAUDE.md for byte-sensitive output and session invariants.

export { PI_ACTIVITY_EXTENSION_FILE } from './piActivity/constants.js';
export { renderPiActivityExtension } from './piActivity/template.js';
export {
  installPiActivityExtension,
  removeProjectPiActivityExtension,
} from './piActivity/install.js';
