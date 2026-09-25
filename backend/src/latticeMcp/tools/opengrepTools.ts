// ---- Opengrep (SAST) ---------------------------------------------------------
//
// Both read tools return the agent-facing DIGEST (markdown, severity-ordered,
// grouped rule → file, under the project's byte budget), never the raw JSON.
// They are available in every session: a worktree agent fixing a finding wants
// the drill-down for its file as much as a planner wants the overview.
//
// `opengrep_ignore` is NOT: it writes the project's ignore lists permanently,
// and a task worktree's brief is untrusted input — a poisoned (or careless) one
// could have the agent ignore exactly the findings its own change introduced,
// hiding them from every later security-review digest. `createServer.ts`
// registers it only outside a task worktree (`registerOpengrepIgnoreTool`).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LatticeCallOutcome, LatticeClient } from '../client.js';
import { toToolResult, type ToolResult } from '../toolResult.js';

// Polling a scan started with `async: true` (the backend answers 202 with its
// id once the scan outlives a short accept window). The budget sits above the
// backend's 10 min hard scan cap (opengrep/scan.ts DEFAULT_SCAN_TIMEOUT_MS —
// not imported: this module must not pull in the backend) so a scan that runs
// to its cap still reports its own timeout rather than "still running".
export const SCAN_POLL_INTERVAL_MS = 5_000;
export const SCAN_POLL_BUDGET_MS = 12 * 60_000;

// Unwrap the `markdown` field of a scan envelope into the text block; every
// other outcome (busy / not installed / unreachable) passes through as-is.
function digestResult(outcome: LatticeCallOutcome): ToolResult {
  if (outcome.kind !== 'ok') return toToolResult(outcome);
  try {
    const parsed = JSON.parse(outcome.text) as { markdown?: unknown; digest?: unknown; scan?: unknown };
    if (typeof parsed.markdown === 'string') {
      return { content: [{ type: 'text', text: parsed.markdown }] };
    }
  } catch {
    /* fall through */
  }
  return toToolResult(outcome);
}

// The id of a scan the backend reports as still running (`202 {scanId,
// status: 'running'}`), or null for any other body.
function runningScanId(outcome: LatticeCallOutcome): string | null {
  if (outcome.kind !== 'ok') return null;
  try {
    const parsed = JSON.parse(outcome.text) as { status?: unknown; scanId?: unknown };
    return parsed.status === 'running' && typeof parsed.scanId === 'string' ? parsed.scanId : null;
  } catch {
    return null;
  }
}

// Not an error: the scan is fine, it just has not finished. The agent must not
// conclude Lattice is down, nor start a second scan (that answers busy).
function stillRunningResult(scanId: string | null): ToolResult {
  const which = scanId ? `scan: "${scanId}"` : 'scan: "latest"';
  const subject = scanId ? `Opengrep scan ${scanId}` : 'The Opengrep scan';
  return {
    content: [
      {
        type: 'text',
        text:
          `${subject} is still running on the Lattice backend — Lattice is up; the scan just has not ` +
          'finished yet (a large project with the broad rule pack can take up to ~10 minutes). Do not ' +
          'start another scan: one runs per project at a time and a second call reports busy. Fetch the ' +
          `result with opengrep_findings (${which}) once it is done.`,
      },
    ],
  };
}

async function pollScan(client: LatticeClient, scanId: string): Promise<ToolResult> {
  let waited = 0;
  while (waited < SCAN_POLL_BUDGET_MS) {
    await client.pause(SCAN_POLL_INTERVAL_MS);
    waited += SCAN_POLL_INTERVAL_MS;
    const outcome = await client.call(`/api/opengrep/scans/${encodeURIComponent(scanId)}`, {
      query: { include: 'markdown' },
    });
    if (runningScanId(outcome)) continue;
    if (outcome.kind === 'timeout') return stillRunningResult(scanId);
    if (outcome.kind === 'httpError' && outcome.status === 404) {
      return {
        content: [
          {
            type: 'text',
            text:
              `Opengrep scan ${scanId} is no longer known to the Lattice backend — it most likely ` +
              'restarted mid-scan, which stops the engine without storing a result. Run opengrep_scan again.',
          },
        ],
        isError: true,
      };
    }
    // The finished digest, or the scan's own failure (409 no-rules, 500
    // scan-failed, …) as an error result.
    return digestResult(outcome);
  }
  return stillRunningResult(scanId);
}

export function registerOpengrepTools(server: McpServer, client: LatticeClient): void {
  server.registerTool(
    'opengrep_scan',
    {
      description:
        'Run an Opengrep static-analysis (SAST) scan of this project with its ' +
        "configured rule packs and return the findings DIGEST: markdown, worst " +
        'severity first, grouped by rule then file, each finding tagged with a ' +
        'short fingerprint (`fp`). Put `opengrep:<fp>` on its own line in any task ' +
        'you file for a finding and search_tasks for it first so re-runs do not ' +
        'duplicate. A scan takes seconds to minutes; one runs per project at a ' +
        'time (a second call reports busy). If the digest says findings were cut ' +
        'for the byte budget, use opengrep_findings with rule= to drill down.',
      inputSchema: {
        targets: z
          .array(z.string())
          .optional()
          .describe('Project-relative paths to scan instead of the whole project.'),
      },
    },
    async ({ targets }) => {
      // `async: true`: a quick scan still answers in this one request; a long
      // one answers 202 with its id at once and is polled below, so no single
      // request outlives the HTTP client's 300 s response timeout.
      const outcome = await client.call('/api/opengrep/scan', {
        method: 'POST',
        body: { ...(targets?.length ? { targets } : {}), includeMarkdown: true, async: true },
      });
      if (outcome.kind === 'timeout') return stillRunningResult(null);
      const scanId = runningScanId(outcome);
      if (scanId) return pollScan(client, scanId);
      return digestResult(outcome);
    },
  );

  server.registerTool(
    'opengrep_findings',
    {
      description:
        'The digest of an EXISTING Opengrep scan (the latest by default) without ' +
        'scanning again — narrowed by rule id, file path or severity floor, and ' +
        'with an optional larger byte budget. This is the drill-down when a digest ' +
        'says rules were left out, and the cheap way to re-read findings for one ' +
        'file. Returns an error if the project has never been scanned.',
      inputSchema: {
        scan: z.string().optional().describe('Scan id from an earlier scan; default "latest".'),
        rule: z
          .string()
          .optional()
          .describe('Only this rule: the full check id or any dot-suffix of it (e.g. "xss.foo").'),
        file: z.string().optional().describe('Only this project-relative file or directory.'),
        severity: z
          .enum(['ERROR', 'WARNING', 'INFO'])
          .optional()
          .describe('Severity floor for this read (INFO shows everything). Default: the project setting.'),
        budgetKb: z
          .number()
          .int()
          .min(8)
          .optional()
          .describe('Digest size ceiling in KB for this read (default: the project setting, 60).'),
      },
    },
    async ({ scan, rule, file, severity, budgetKb }) => {
      const outcome = await client.call(`/api/opengrep/scans/${encodeURIComponent(scan ?? 'latest')}`, {
        query: { include: 'markdown', rule, file, severity, budgetKb },
      });
      // Asked for a scan id that is still running (an opengrep_scan that
      // reported "still running"): say so rather than hand back the 202 body.
      const running = runningScanId(outcome);
      if (running) return stillRunningResult(running);
      return digestResult(outcome);
    },
  );
}

// Registered only outside a task worktree — see the header.
export function registerOpengrepIgnoreTool(server: McpServer, client: LatticeClient): void {
  server.registerTool(
    'opengrep_ignore',
    {
      description:
        "Add rule ids and/or finding fingerprints to THIS project's Opengrep ignore " +
        'list, so they are filtered out of every future digest. Use it for findings ' +
        'you have judged to be rule noise for this codebase (a rule that ' +
        'misfires on a local helper, a policy the project already meets another ' +
        'way) instead of filing a task that asks a human to do it. Additive and ' +
        'deduplicated; entries are removed in Settings → Tools. Say in your ' +
        'wrap-up what you ignored and why.',
      inputSchema: {
        ruleIds: z
          .array(z.string())
          .optional()
          .describe('Rule ids to ignore: full check ids or any dot-suffix (e.g. "i18next-key-format").'),
        fingerprints: z
          .array(z.string())
          .optional()
          .describe('Individual findings to ignore, by the short fp from the digest (the `opengrep:<fp>` spelling is accepted).'),
        reason: z.string().optional().describe('One line on why — echoed back, not stored.'),
      },
    },
    async ({ ruleIds, fingerprints, reason }) => {
      const outcome = await client.call('/api/opengrep/ignore', {
        method: 'POST',
        body: {
          ...(ruleIds?.length ? { ruleIds } : {}),
          ...(fingerprints?.length ? { fingerprints } : {}),
        },
      });
      const result = toToolResult(outcome);
      // Echo the agent's stated reason back with the result (it is never sent
      // to the API), so the transcript carries the why next to the what.
      const why = reason?.trim();
      if (why && !result.isError) {
        result.content = [{ type: 'text', text: `${outcome.text}\nreason: ${why}` }];
      }
      return result;
    },
  );
}
