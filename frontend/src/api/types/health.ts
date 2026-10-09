// Per-file code-health metrics and the `/ws/health` update stream — the
// backend's own types (backend/src/health/types.ts, re-exported through
// backend/src/shared/wireTypes.ts). `DeadCodeStatus` drives the `D` dead-code
// overlay: live=green, dead=red, entry/uncertain=neutral grey.
export type {
  DeadCodeStatus,
  HalsteadMetrics,
  HealthLanguage,
  HealthMetrics,
  HealthSmell,
  HealthSmellId,
  HealthUpdate,
} from '../../../../backend/src/shared/wireTypes';
