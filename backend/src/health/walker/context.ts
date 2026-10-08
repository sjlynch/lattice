import type { GrammarKey } from '../parser.js';
import type { NodeKinds } from '../nodeKinds.js';
import type { FnRecord } from './functionRecord.js';
import type { FileAnalysis } from '../walker.js';

export type WalkerExportState = {
  hasDefaultExport: boolean;
  namedExportCount: number;
};

export type WalkerContext = {
  result: FileAnalysis;
  grammar: GrammarKey;
  kinds: NodeKinds;
  isJsFamily: boolean;
  isTs: boolean;
  fnStack: FnRecord[];
  exportState: WalkerExportState;
};

export function currentFunction(ctx: WalkerContext): FnRecord | null {
  return ctx.fnStack.length > 0 ? ctx.fnStack[ctx.fnStack.length - 1] : null;
}
