import type { HealthMetrics } from '../../api';
import {
  buildHealthScoreContributions,
  type HealthScoreContribution,
} from './healthScoreContributions';

type ScoreComponentId = HealthScoreContribution['componentId'];

export type MetricRowModel = {
  label: string;
  value: number | string;
  suffix?: string;
  contribution?: HealthScoreContribution;
};

export function buildHealthMetricRows(m: HealthMetrics): MetricRowModel[] {
  const contributions = buildHealthScoreContributions(m);
  const rows: MetricRowModel[] = [
    scoreRow(contributions, 'file_size', { label: 'LOC', value: m.loc }),
    scoreRow(contributions, 'maintainability_index', {
      label: 'Maintainability',
      value: m.maintainabilityIndex,
      suffix: '/100',
    }),
    scoreRow(contributions, 'smell_density', {
      label: 'Smells/LOC',
      value: m.loc > 0 ? (m.smellCount / m.loc).toFixed(3) : '0.000',
    }),
  ];

  if (m.language !== 'fallback') {
    rows.push(
      scoreRow(contributions, 'cognitive_complexity', {
        label: 'Cognitive',
        value: m.cognitiveMax,
        suffix: 'max',
      }),
      scoreRow(contributions, 'cyclomatic_complexity', {
        label: 'Cyclomatic',
        value: m.cyclomaticMax,
        suffix: 'max',
      }),
      scoreRow(contributions, 'nesting_depth', {
        label: 'Nesting',
        value: m.maxNestingDepth,
        suffix: 'deep',
      }),
      scoreRow(contributions, 'function_length', {
        label: 'Max fn len',
        value: m.maxFunctionLength,
      }),
      scoreRow(contributions, 'call_graph_density', {
        label: 'Call density',
        value: m.callGraphDensity.toFixed(2),
      }),
      {
        label: 'Functions',
        value: `${m.namedFunctionCount}`,
        suffix:
          m.functionCount > m.namedFunctionCount
            ? `(+${m.functionCount - m.namedFunctionCount} anon)`
            : undefined,
      },
      {
        label: 'Avg fn len',
        value: m.avgFunctionLength > 0 ? Math.round(m.avgFunctionLength) : 0,
      },
      { label: 'Max params', value: m.maxParamCount },
      { label: 'Classes', value: m.classCount },
      {
        label: 'Halstead vol',
        value: m.halstead.volume > 0 ? Math.round(m.halstead.volume) : 0,
      },
    );
  }

  rows.push({
    label: 'Comments',
    value: `${Math.round(m.commentRatio * 100)}%`,
  });

  if (m.fanIn != null) {
    rows.push(scoreRow(contributions, 'fan_in', { label: 'Fan-in', value: m.fanIn }));
  }
  if (m.fanOut != null) {
    rows.push(scoreRow(contributions, 'fan_out', { label: 'Fan-out', value: m.fanOut }));
  }
  if (m.inCycle) {
    rows.push(scoreRow(contributions, 'circular_dependency', {
      label: 'In cycle',
      value: 'yes',
    }));
  }
  if (m.deadCode && m.deadCode !== 'live') {
    rows.push({ label: 'Reachability', value: DEAD_CODE_TOOLTIP[m.deadCode] });
  }

  return rows;
}

// Surfaced in the hover tooltip (any overlay) so a node flagged by the `D`
// view explains itself. `live` is omitted — the common case needs no callout.
const DEAD_CODE_TOOLTIP: Record<
  NonNullable<HealthMetrics['deadCode']>,
  string
> = {
  live: 'reachable',
  dead: 'dead — no path from an entry point',
  entry: 'entry point',
  uncertain: 'uncertain (asset / dynamic / unsupported)',
};

function scoreRow(
  contributions: Record<ScoreComponentId, HealthScoreContribution>,
  componentId: ScoreComponentId,
  row: Omit<MetricRowModel, 'contribution'>,
): MetricRowModel {
  return { ...row, contribution: contributions[componentId] };
}
