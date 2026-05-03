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
