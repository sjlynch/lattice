import type { MergeRun } from './types.js';

export function snapshotRun(run: MergeRun): MergeRun {
  return {
    ...run,
    merged: [...run.merged],
    conflicted: [...run.conflicted],
    errored: run.errored.map((e) => ({ ...e })),
    ...(run.resolvers ? { resolvers: Object.fromEntries(Object.entries(run.resolvers).map(([id, r]) => [id, { ...r }])) } : {}),
  };
}
