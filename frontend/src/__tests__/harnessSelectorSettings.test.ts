import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessAvailability, UserSettings } from '../api';
import type { HarnessChoice } from '../harnesses';
import {
  applyLoadedHarnessSettings,
  type ApplyHarnessSettingsDeps,
} from '../components/taskboard/hooks/useHarnessSelector.ts';

type Recorder = {
  deps: ApplyHarnessSettingsDeps;
  piModel: string | undefined;
  piModelWrites: number;
  harness: HarnessChoice | undefined;
  harnessWrites: number;
  persistedClaudeFor: string | null;
};

function recorder(cancelled: boolean): Recorder {
  const r: Recorder = {
    piModel: 'SENTINEL',
    piModelWrites: 0,
    harness: undefined,
    harnessWrites: 0,
    persistedClaudeFor: null,
    deps: {
      setPiModel: (m) => {
        r.piModel = m;
        r.piModelWrites += 1;
      },
      setHarness: (h) => {
        r.harness = h;
        r.harnessWrites += 1;
      },
      persistClaude: (folder) => {
        r.persistedClaudeFor = folder;
      },
      isCancelled: () => cancelled,
    },
  };
  return r;
}

const AVAIL: HarnessAvailability = { claude: true, pi: true, codex: true };
const settings = (s: Partial<UserSettings>): Pick<UserSettings, 'harness' | 'piModel'> => ({
  harness: s.harness,
  piModel: s.piModel,
});

// The core regression: project A's fetchUserSettings resolves AFTER the hook
// re-rendered with project B (so the cleanup ran and `cancelled` is true). A
// stale resolution must touch nothing — no harness/piModel write, no persist —
// or B would silently spawn runs with A's harness/model.
test('a settings fetch that resolves after the folder changed is discarded', () => {
  const r = recorder(/* cancelled */ true);

  applyLoadedHarnessSettings(
    'C:/project-A',
    settings({ harness: 'pi', piModel: 'openai/gpt-4o' }),
    AVAIL,
    r.deps,
  );

  assert.equal(r.piModelWrites, 0, 'no piModel write from a stale fetch');
  assert.equal(r.harnessWrites, 0, 'no harness write from a stale fetch');
  assert.equal(r.piModel, 'SENTINEL', 'piModel state left untouched');
  assert.equal(r.harness, undefined, 'harness state left untouched');
  assert.equal(r.persistedClaudeFor, null, 'no persist from a stale fetch');
});

// A live (non-cancelled) resolution applies the saved harness + piModel.
test('a live resolution applies the saved harness and piModel', () => {
  const r = recorder(/* cancelled */ false);

  applyLoadedHarnessSettings(
    'C:/project-B',
    settings({ harness: 'pi', piModel: 'openai/gpt-4o' }),
    AVAIL,
    r.deps,
  );

  assert.equal(r.harness, 'pi');
  assert.equal(r.piModel, 'openai/gpt-4o');
  assert.equal(r.persistedClaudeFor, null, 'an available harness is not coerced');
});

// An uninstalled harness coerces back to claude and persists that for the folder.
test('an unavailable harness coerces to claude and persists', () => {
  const r = recorder(/* cancelled */ false);

  applyLoadedHarnessSettings(
    'C:/project-B',
    settings({ harness: 'pi' }),
    { claude: true, pi: false, codex: false },
    r.deps,
  );

  assert.equal(r.harness, 'claude');
  assert.equal(r.persistedClaudeFor, 'C:/project-B', 'coercion persisted for the active folder');
});
