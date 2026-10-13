// Controller mode's instance table: which Lattice backends the `lattice-control`
// server can drive, parsed once from env at startup (pure — no I/O).
//
//   LATTICE_INSTANCES  JSON `{"main":"http://localhost:5184"}` or
//                      `main=http://localhost:5184,exp=http://localhost:5484`
//                      (a bare URL is named after its port).
//   LATTICE_API_URL    when set, the DEFAULT (first) instance: the entry of
//                      LATTICE_INSTANCES with the same URL, else `default`.
//   LATTICE_PROJECT    the default `project` — for the default instance ONLY,
//                      so a forgotten `project` on another instance can never
//                      aim it at the board the session was started for.
// Nothing set → `default=http://localhost:5184`.
//
// A tool's `instance` argument is a configured name, or an ad-hoc LOOPBACK URL
// (`http://localhost:5484`): an agent may reach another local instance without
// configuration, never an arbitrary host.

export type LatticeInstance = { name: string; url: string };

export type InstanceConfig = {
  // Non-empty; the first is the default.
  instances: LatticeInstance[];
  defaultProject?: string;
};

const DEFAULT_URL = 'http://localhost:5184';
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// `http(s)://host[:port][/prefix]` without a trailing slash, or null.
function normalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.search || url.hash || url.username || url.password) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

function parseList(raw: string): { entries: [string, string][] } | { error: string } {
  const text = raw.trim();
  if (text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { error: `LATTICE_INSTANCES is not valid JSON: ${(err as Error).message}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'LATTICE_INSTANCES JSON must be an object of name → URL.' };
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    const bad = entries.find(([, v]) => typeof v !== 'string');
    if (bad) return { error: `LATTICE_INSTANCES: the URL for "${bad[0]}" must be a string.` };
    return { entries: entries as [string, string][] };
  }
  const entries: [string, string][] = [];
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq > 0 && !part.slice(0, eq).includes('://')) {
      entries.push([part.slice(0, eq), part.slice(eq + 1)]);
    } else {
      const url = normalizeUrl(part);
      if (!url) return { error: `LATTICE_INSTANCES: "${part}" is neither name=url nor a URL.` };
      entries.push([new URL(url).port || new URL(url).hostname, part]);
    }
  }
  return { entries };
}

export function parseInstanceConfig(
  env: Record<string, string | undefined>,
): { config: InstanceConfig } | { error: string } {
  const instances: LatticeInstance[] = [];
  const listRaw = env.LATTICE_INSTANCES?.trim();
  if (listRaw) {
    const list = parseList(listRaw);
    if ('error' in list) return list;
    for (const [name, rawUrl] of list.entries) {
      if (!NAME_RE.test(name)) {
        return { error: `LATTICE_INSTANCES: instance name "${name}" may only use letters, digits, _ . -` };
      }
      if (instances.some((i) => i.name.toLowerCase() === name.toLowerCase())) {
        return { error: `LATTICE_INSTANCES: instance "${name}" is listed twice.` };
      }
      const url = normalizeUrl(rawUrl);
      if (!url) return { error: `LATTICE_INSTANCES: "${rawUrl}" (instance "${name}") is not an http(s) URL.` };
      instances.push({ name, url });
    }
  }

  const apiRaw = env.LATTICE_API_URL?.trim();
  if (apiRaw) {
    const url = normalizeUrl(apiRaw);
    if (!url) return { error: `LATTICE_API_URL "${apiRaw}" is not an http(s) URL.` };
    const same = instances.findIndex((i) => i.url === url);
    if (same >= 0) {
      instances.unshift(...instances.splice(same, 1));
    } else if (instances.some((i) => i.name.toLowerCase() === 'default')) {
      return {
        error:
          `LATTICE_INSTANCES names a "default" instance, but LATTICE_API_URL (${url}) is a ` +
          'different URL; rename that entry or point it at LATTICE_API_URL.',
      };
    } else {
      instances.unshift({ name: 'default', url });
    }
  }
  if (instances.length === 0) instances.push({ name: 'default', url: DEFAULT_URL });

  const defaultProject = env.LATTICE_PROJECT?.trim() || undefined;
  return { config: { instances, ...(defaultProject ? { defaultProject } : {}) } };
}

// The instance a tool call names: '' / absent → the default; a configured name
// (case-insensitive) or URL; else an ad-hoc loopback URL. Null when none.
export function resolveInstance(
  config: InstanceConfig,
  arg: string | undefined,
): LatticeInstance | null {
  const wanted = arg?.trim();
  if (!wanted) return config.instances[0];
  const byName = config.instances.find((i) => i.name.toLowerCase() === wanted.toLowerCase());
  if (byName) return byName;
  const url = normalizeUrl(wanted);
  if (!url) return null;
  const byUrl = config.instances.find((i) => i.url === url);
  if (byUrl) return byUrl;
  return LOOPBACK_HOSTS.has(new URL(url).hostname) ? { name: url, url } : null;
}
