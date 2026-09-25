// ---- Opengrep (SAST) ---------------------------------------------------------
//
// Both read tools return the agent-facing DIGEST (markdown, severity-ordered,
// grouped rule → file, under the project's byte budget), never the raw JSON.
// Available in every session: a worktree agent fixing a finding wants the
// drill-down for its file as much as a planner wants the overview.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LatticeCallOutcome, LatticeClient } from '../client.js';
import { toToolResult, type ToolResult } from '../toolResult.js';

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
    async ({ targets }) =>
      digestResult(
        await client.call('/api/opengrep/scan', {
          method: 'POST',
          body: { ...(targets?.length ? { targets } : {}), includeMarkdown: true },
        }),
      ),
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
    async ({ scan, rule, file, severity, budgetKb }) =>
      digestResult(
        await client.call(`/api/opengrep/scans/${encodeURIComponent(scan ?? 'latest')}`, {
          query: { include: 'markdown', rule, file, severity, budgetKb },
        }),
      ),
  );

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
