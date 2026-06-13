export type HealthLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'csharp'
  | 'ruby'
  | 'fallback';

export type HealthSmellId =
  | 'todo_fixme'
  | 'magic_number'
  | 'long_string_literal'
  | 'commented_code'
  | 'empty_catch'
  | 'large_file'
  | 'long_function'
  | 'high_complexity'
  | 'high_cognitive_complexity'
  | 'deep_nesting'
  | 'long_param_list'
  | 'multiple_classes'
  | 'high_function_count'
  | 'low_maintainability'
  | 'god_function'
  | 'console_log'
  | 'debugger_stmt'
  | 'any_type'
  | 'type_assertion'
  | 'ts_ignore'
  | 'eslint_disable'
  | 'non_null_assertion'
  | 'var_keyword'
  | 'loose_equality'
  | 'eval_call'
  | 'mixed_exports'
  | 'deep_optional_chain'
  | 'deep_ternary'
  | 'mixed_sync_async'
  | 'boolean_param'
  | 'magic_string'
  | 'empty_interface'
  | 'print_call'
  | 'bare_except'
  | 'wildcard_import'
  | 'mutable_default_arg'
  | 'global_keyword'
  | 'missing_docstring'
  | 'circular_dependency'
  | 'high_fan_out'
  | 'high_fan_in';

export type HealthSmell = {
  id: HealthSmellId;
  count: number;
  label: string;
};

// Mirror of backend `DeadCodeStatus` (health/types.ts). Drives the `D`
// dead-code overlay: live=green, dead=red, entry/uncertain=neutral grey.
export type DeadCodeStatus = 'live' | 'dead' | 'entry' | 'uncertain';

export type HalsteadMetrics = {
  vocabulary: number;
  length: number;
  volume: number;
  difficulty: number;
  effort: number;
};

export type HealthMetrics = {
  score: number;
  language: HealthLanguage;
  loc: number;
  commentRatio: number;
  cyclomaticMax: number;
  cyclomaticTotal: number;
  cognitiveMax: number;
  cognitiveTotal: number;
  maxNestingDepth: number;
  halstead: HalsteadMetrics;
  maintainabilityIndex: number;
  functionCount: number;
  namedFunctionCount: number;
  avgFunctionLength: number;
  maxFunctionLength: number;
  maxParamCount: number;
  classCount: number;
  callGraphDensity: number;
  godFunctionRatio: number;
  fanIn?: number;
  fanOut?: number;
  inCycle?: boolean;
  deadCode?: DeadCodeStatus;
  smells: HealthSmell[];
  smellCount: number;
};

export type HealthUpdate =
  | { type: 'updated'; filePath: string; metrics: HealthMetrics }
  | { type: 'removed'; filePath: string }
  | { type: 'rescan'; reason: 'config' | 'directory'; path: string };
