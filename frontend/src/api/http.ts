// Typed fetch helper. Pulls `{error}` out of non-2xx responses so toast
// messages get the backend's actual error text instead of a bare HTTP
// status code.

// Error thrown for a non-2xx response. Carries the HTTP status so callers that
// need to branch on it (e.g. the workflow queue treating a 409 "slot busy" as
// retry-able rather than a hard failure) can, while everything that only reads
// `.message` keeps working since it extends Error.
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export async function asJson<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      const j = (await r.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new HttpError(r.status, msg);
  }
  return (await r.json()) as T;
}

function jsonRequestInit(method: 'POST' | 'PATCH', body?: unknown): RequestInit {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return init;
}

export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  return asJson<T>(await fetch(url, jsonRequestInit('POST', body)));
}

export async function patchJson<T>(url: string, body?: unknown): Promise<T> {
  return asJson<T>(await fetch(url, jsonRequestInit('PATCH', body)));
}

export async function deleteJson<T>(url: string): Promise<T> {
  return asJson<T>(await fetch(url, { method: 'DELETE' }));
}
