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
