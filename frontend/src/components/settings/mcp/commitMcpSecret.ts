import { setMcpSecret } from '../../../api/mcp';

export type CommitSecretResult = { ok: true } | { ok: false; error: string };

const FALLBACK_ERROR = 'Could not save the key — check your connection and try again.';

// Persist one MCP secret, normalizing any rejection into a non-empty,
// displayable error string instead of letting it throw.
//
// Secrets autosave on blur (a separate store), so a failed save never reaches
// the dialog's Save-button error path. Returning the error here — rather than
// swallowing the throw — lets the field surface it inline and stay open for a
// retry, instead of looking saved when it wasn't.
export async function commitMcpSecret(
  serverId: string,
  envVar: string,
  value: string,
  save: (serverId: string, envVar: string, value: string) => Promise<unknown> = setMcpSecret,
): Promise<CommitSecretResult> {
  try {
    await save(serverId, envVar, value);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message.trim() : '';
    return { ok: false, error: msg || FALLBACK_ERROR };
  }
}
