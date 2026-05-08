// Per-file code health metrics. The score is 0–100 (0 = critically
// unhealthy, 100 = exemplary). Components feed both the score and the
// on-graph hover tooltip.
//
// Tree-sitter–based pipeline produces this from the AST of TS/JS/Python
// files (other languages still get LOC + universal smells until their
// grammars are wired up).

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

// Smell catalog. Adding a new smell = add an id + label here, emit it
// from a query/analyzer, and add an item in `addSizeSmells` if it's
// computed from aggregate metrics rather than directly from queries.
export type HealthSmellId =
  // Universal
  | 'todo_fixme'
  | 'magic_number'
  | 'long_string_literal'
  | 'commented_code'
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
  // TS / JS
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
  | 'empty_catch'
  | 'deep_optional_chain'
  | 'deep_ternary'
  | 'mixed_sync_async'
  | 'boolean_param'
  | 'magic_string'
  | 'empty_interface'
  // Python
  | 'print_call'
  | 'bare_except'
  | 'wildcard_import'
  | 'mutable_default_arg'
  | 'global_keyword'
  | 'missing_docstring'
  // Cross-file
  | 'circular_dependency'
  | 'high_fan_out'
  | 'high_fan_in';

export type HealthSmell = {
  id: HealthSmellId;
  count: number;
  label: string;
};

// Halstead metrics derived from operator/operand tokenization. Volume
// feeds into the Maintainability Index. Difficulty / effort are
// retained for power users but not currently surfaced in the score.
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

  // Size
  loc: number;
  commentRatio: number;

  // Complexity
  cyclomaticMax: number;
  cyclomaticTotal: number;
  cognitiveMax: number;
  cognitiveTotal: number;
  maxNestingDepth: number;
  halstead: HalsteadMetrics;
  maintainabilityIndex: number;

  // Structure
  functionCount: number;
  namedFunctionCount: number;
  avgFunctionLength: number;
  maxFunctionLength: number;
  maxParamCount: number;
  classCount: number;

  // Within-file call graph
  callGraphDensity: number;
  godFunctionRatio: number;

  // Cross-file (filled in by crossFile.ts after the per-file pass)
  fanIn?: number;
  fanOut?: number;
  inCycle?: boolean;

  // Smells
  smells: HealthSmell[];
  smellCount: number;
};

export const TINY_FILE_LOC_THRESHOLD = 30;

export const SMELL_LABELS: Record<HealthSmellId, string> = {
  todo_fixme: 'TODO/FIXME comments',
  magic_number: 'magic numbers',
  long_string_literal: 'long string literals',
  commented_code: 'commented-out code blocks',
  large_file: 'file exceeds 800 LOC',
  long_function: 'functions over 75 lines (own body)',
  high_complexity: 'function cyclomatic over 15',
  high_cognitive_complexity: 'function cognitive over 15',
  deep_nesting: 'nesting depth over 5',
  long_param_list: 'function with >5 parameters',
  multiple_classes: 'multiple classes in one file',
  high_function_count: 'over 20 named functions in one file',
  low_maintainability: 'maintainability index under 65',
  god_function: 'a function that calls most others in the file',
  console_log: 'console.* calls',
  debugger_stmt: 'debugger statements',
  any_type: '`any` type annotations',
  type_assertion: '`as` type assertions',
  ts_ignore: '@ts-ignore / @ts-expect-error',
  eslint_disable: 'eslint-disable directives',
  non_null_assertion: 'non-null assertions (`!`)',
  var_keyword: '`var` keyword',
  loose_equality: '`==` / `!=` (loose equality)',
  eval_call: '`eval`/`new Function` call',
  mixed_exports: 'mixed default + many named exports',
  empty_catch: 'empty catch blocks',
  deep_optional_chain: 'optional chains over 4 deep',
  deep_ternary: 'ternaries nested 3+ deep',
  mixed_sync_async: '`async` function with no `await`',
  boolean_param: 'boolean parameters (hidden modes)',
  magic_string: 'string literals duplicated 3+ times',
  empty_interface: 'empty interface / one-method class',
  print_call: '`print(...)` call',
  bare_except: 'bare `except:` block',
  wildcard_import: '`import *`',
  mutable_default_arg: 'mutable default argument',
  global_keyword: '`global` keyword',
  missing_docstring: 'missing module/function docstrings',
  circular_dependency: 'file is part of an import cycle',
  high_fan_out: 'imports too many other files',
  high_fan_in: 'imported by many files (change blast radius)',
};
