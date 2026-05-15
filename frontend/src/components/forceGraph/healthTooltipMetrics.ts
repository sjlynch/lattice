import type { HealthMetrics } from '../../api';

export type MetricRowModel = {
  label: string;
  value: number | string;
  suffix?: string;
};

export function buildHealthMetricRows(m: HealthMetrics): MetricRowModel[] {
  const rows: MetricRowModel[] = [
    { label: 'LOC', value: m.loc },
    {
      label: 'Maintainability',
      value: m.maintainabilityIndex,
      suffix: '/100',
    },
  ];

  if (m.language !== 'fallback') {
    rows.push(
      { label: 'Cyclomatic', value: m.cyclomaticMax, suffix: 'max' },
      { label: 'Cognitive', value: m.cognitiveMax, suffix: 'max' },
      { label: 'Nesting', value: m.maxNestingDepth, suffix: 'deep' },
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
      { label: 'Max fn len', value: m.maxFunctionLength },
      { label: 'Max params', value: m.maxParamCount },
      { label: 'Classes', value: m.classCount },
      {
        label: 'Call density',
        value: m.callGraphDensity.toFixed(2),
      },
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

  if (m.fanIn != null) rows.push({ label: 'Fan-in', value: m.fanIn });
  if (m.fanOut != null) rows.push({ label: 'Fan-out', value: m.fanOut });
  if (m.inCycle) rows.push({ label: 'In cycle', value: 'yes' });

  return rows;
}
