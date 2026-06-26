// Typed fetch helper. Pulls `{error}` out of non-2xx responses so toast
// messages get the backend's actual error text instead of a bare HTTP
// status code.

export async function asJson<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      const j = (await r.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
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
