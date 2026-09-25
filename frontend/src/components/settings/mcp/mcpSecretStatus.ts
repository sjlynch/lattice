import type {
  McpEnvPresence,
  McpSecretHints,
  McpServerEntry,
  RedactedMcpSecrets,
} from '../../../api';

// A server's declared secret env var (the built-in key). Custom servers may
// have several; the row's chip reflects the first/required one.
export function primaryEnvVar(s: McpServerEntry): string | undefined {
  return s.requiresSecret?.envVar ?? s.secretEnvVars?.[0];
}

export function hasSecret(redacted: RedactedMcpSecrets, s: McpServerEntry): boolean {
  const v = primaryEnvVar(s);
  return !!v && redacted[s.id]?.[v] === true;
}
export function secretHint(hints: McpSecretHints, s: McpServerEntry): string | undefined {
  const v = primaryEnvVar(s);
  return v ? hints[s.id]?.[v] : undefined;
}
export function hasEnv(presence: McpEnvPresence, s: McpServerEntry): boolean {
  const v = primaryEnvVar(s);
  return !!v && presence[s.id]?.[v] === true;
}
