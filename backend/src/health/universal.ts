// Re-export shim for universal text analysis helpers. The focused modules live
// under `./universal/` so callers can keep importing `./universal.js`.

export {
  COMMENT_BY_EXT,
  type CommentSyntax,
} from './universal/commentSyntax.js';
export { countLineKinds, type LineCounts } from './universal/lineCounts.js';
export { stripStringsAndComments } from './universal/strip.js';
export {
  bump,
  countUniversalSmells,
  type SmellCounter,
} from './universal/smells.js';
