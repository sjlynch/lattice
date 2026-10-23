// Whether a request came from a browser page (the Lattice UI): it carries
// `Origin` or `Sec-Fetch-Site`, which browsers always send on fetches and
// curl / MCP clients / agents don't. The global Origin check already refuses
// foreign origins, so a browser request here is the user at the UI. A
// guardrail for well-behaved agents, not authentication — any local process
// can set headers.

import type { Request } from 'express';

// `Sec-Fetch-Site: cross-site` is a page on ANOTHER site navigating here (a
// top-level GET carries no Origin): never the user at the UI.
const SAME_SITE = new Set(['same-origin', 'same-site', 'none']);
export const isBrowserRequest = (req: Request): boolean =>
  !!req.get('origin') || SAME_SITE.has(String(req.get('sec-fetch-site') ?? '').toLowerCase());
