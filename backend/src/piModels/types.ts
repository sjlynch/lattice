export type PiModelInfo = {
  provider: string;
  model: string;
  // `${provider}/${model}` — the value passed to `pi --model`.
  pattern: string;
  // Raw display strings from the table (e.g. "204.8K"); UI hints only.
  contextWindow?: string;
  thinking?: boolean;
};

export type PiMenuEntry = {
  pattern: string;
  // Friendly label WITHOUT the "Pi — " prefix (the frontend adds it).
  label: string;
};

export type PiModelsResult = {
  models: PiModelInfo[];
  menu: PiMenuEntry[];
  // Pi's currently-configured default model ("provider/model"), or null.
  defaultPattern: string | null;
};

export type ModelsJson = {
  providers?: Record<
    string,
    { models?: Array<{ id?: string; name?: string }> }
  >;
};

export type ModelsCache = { at: number; models: PiModelInfo[] };

// A Lattice-managed Pi provider — `globalSettings.piProviders`, validated by
// ../piProviderValidation.ts (which re-exports these) and reconciled into
// `~/.pi/agent/models.json` by reconcile.ts. Declared here, node-free, so the
// frontend's Pi tab shares them through ../shared/wireTypes.ts.
export type PiProviderModel = {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  // The `reasoning_effort` tokens this endpoint said it accepts, detected once
  // per model (probe.ts `probeThinkingLevels`). Reconcile turns this into Pi's
  // `thinkingLevelMap`, which is the ONLY way `xhigh` / `max` become
  // reachable — without it Pi silently clamps them to `high`. `[]` = probed,
  // nothing extended.
  thinkingLevels?: string[];
};

export type PiProvider = {
  id: string; // models.json provider key
  baseUrl: string;
  api?: string; // default 'openai-completions'
  // Literal, `$VAR` / `${VAR}` env interpolation, or `!command` — Pi resolves
  // all three at request time. NOTE a bare `MY_API_KEY` is a LITERAL to Pi, not
  // an env lookup. Lattice's probe resolves none of them (see probe.ts).
  apiKey?: string;
  // Absent leaves existing models.json overrides alone; an explicit empty map
  // clears them. Keep empty maps through validation and persisted settings.
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  // Keep `models` in sync with whatever `<baseUrl>/models` currently reports.
  // Absent means ON: an endpoint saved before auto-discovery existed, or added
  // by someone who never opened Advanced, should still end up working rather
  // than sitting there with an empty model list. See autoDiscover.ts.
  autoDiscover?: boolean;
  models: PiProviderModel[];
};
