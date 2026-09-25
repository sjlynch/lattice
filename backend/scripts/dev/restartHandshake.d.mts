// Hand-written declarations for the dev runner's restart handshake client.
// Keep in sync with restartHandshake.mjs.

export const HANDSHAKE_BACKEND_PORT: number;
export const HANDSHAKE_ROUTE_PREFIX: string;
export const HANDSHAKE_AUTH_HEADER: string;
export const PREPARE_SETTLE_BUDGET_MS: number;
export const PREPARE_TIMEOUT_MS: number;
export const DRAIN_TTL_MS: number;
export const CANCEL_TIMEOUT_MS: number;
export const LOCK_HOLDERS_TIMEOUT_MS: number;

export function readHandshakeToken(): string | null;

export type HandshakeFailure = { ok: false; why: string };
export type PrepareResult =
  | { ok: true; ready: boolean; pending: string[]; waitedMs: number }
  | HandshakeFailure;
export type LockHolder = {
  hash: string;
  project?: string;
  parkedOn: 'conflict-resolver' | 'post-merge-hook' | null;
  detail?: string;
};
export type LockHoldersResult = { ok: true; pid: number; holders: LockHolder[] } | HandshakeFailure;

export interface RestartHandshake {
  prepare(reason: string): Promise<PrepareResult>;
  cancel(reason: string): Promise<{ ok: true } | HandshakeFailure>;
  lockHolders(): Promise<LockHoldersResult>;
}

export function createRestartHandshake(options?: {
  port?: number;
  readToken?: () => string | null;
  fetchImpl?: typeof fetch;
  prepareTimeoutMs?: number;
  settleBudgetMs?: number;
  drainTtlMs?: number;
}): RestartHandshake;
