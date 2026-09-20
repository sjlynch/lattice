// Increment only for incompatible wire changes. Fingerprints still detect code
// changes; a compatible old executor may keep serving while its PTYs are live.
export const TERMINAL_PROTOCOL_VERSION = 1;
export const SESSION_REQUEST_MAX_AGE_MS = 5 * 60_000;
export const SESSION_REQUEST_FUTURE_SKEW_MS = 60_000;
export const SESSION_REQUEST_RETENTION_MS = 10 * 60_000;

export type TerminalServerInfo = {
  fingerprint: string;
  instanceId?: string;
  protocolVersion?: number;
  capabilities?: {
    idempotentCreate: boolean;
    shutdownIfIdle: boolean;
    // The executor records each session's OSC title itself (`terminalTitle`
    // in `/sessions`), so the main backend need not parse pty output for it.
    // Absent on retained older executors, for which the WS relay keeps its
    // per-frame title observer.
    nativeTerminalTitle?: boolean;
  };
};

export type SessionRequestIdentity = {
  requestId?: string;
  requestTimestamp?: number;
  // Refuse a replay reaching a replacement executor: its in-memory dedupe map
  // cannot tell whether the previous executor already ran the command.
  serverInstanceId?: string;
};
