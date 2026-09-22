import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { TerminalSpec } from '../terminal/terminalTypes.ts';
import {
  isPathWithin,
  normalizeDirPath,
  sameProjectPath,
  terminalBelongsToProject,
} from '../terminal/terminalScope.ts';

// Workflows / workflow runs carry the backend's realpath spelling; a strict
// `===` against activeFolder hid every workflow and made a started queue run
// look failed when the two differed only by casing or separators.
test('sameProjectPath ignores casing, separators and a trailing slash', () => {
  assert.equal(sameProjectPath('C:\\Dev\\Proj', 'c:/dev/proj/'), true);
  assert.equal(sameProjectPath('C:\\Dev\\Proj', 'C:\\Dev\\Proj2'), false);
  assert.equal(sameProjectPath(undefined, 'C:\\Dev\\Proj'), false);
  assert.equal(sameProjectPath('', ''), false);
});
import { useTerminalGroups } from '../components/sidebar/hooks/useTerminalGroups.ts';
import { installGlobal } from './domDoubles.ts';

const PROJECT_A = 'C:/project-A';
const PROJECT_B = 'C:/project-B';

function term(partial: Partial<TerminalSpec> & { id: string; cwd: string }): TerminalSpec {
  return { label: partial.id, ...partial };
}

// ---- pure helpers ---------------------------------------------------------

test('normalizeDirPath unifies separators, trailing slash, and case', () => {
  assert.equal(normalizeDirPath('C:\\project-A'), 'c:/project-a');
  assert.equal(normalizeDirPath('C:/project-A/'), 'c:/project-a');
  assert.equal(normalizeDirPath('/home/me/Repo//'), '/home/me/repo');
});

test('isPathWithin matches self + descendants, respecting segment boundaries', () => {
  assert.equal(isPathWithin('C:/project-A', 'C:/project-A'), true, 'same dir');
  assert.equal(isPathWithin('C:/project-A/sub/dir', 'C:/project-A'), true, 'descendant');
  assert.equal(isPathWithin('C:\\project-A\\sub', 'C:/project-A'), true, 'mixed separators');
  assert.equal(isPathWithin('C:/project-B', 'C:/project-A'), false, 'sibling');
  // Prefix that is not a path-segment boundary must not match.
  assert.equal(isPathWithin('C:/project-A-other', 'C:/project-A'), false, 'name prefix');
  assert.equal(isPathWithin('C:/project-A', ''), false, 'empty parent never contains');
});

test('terminalBelongsToProject scopes tagged terminals strictly by projectPath', () => {
  const tagged = term({ id: 't', cwd: '/wt/t', projectPath: PROJECT_A });
  assert.equal(terminalBelongsToProject(tagged, PROJECT_A), true);
  assert.equal(terminalBelongsToProject(tagged, PROJECT_B), false);
});

test('terminalBelongsToProject matches a registry projectPath that differs only by casing / separators', () => {
  // A registry record's projectPath is stamped by the backend from
  // realpathSync.native; the frontend's canonicalProjectPath only uppercases
  // the drive letter. A strict `===` listed NO registry tabs for such a folder.
  const registered = term({ id: 'r', cwd: 'C:\\Project-A\\sub', projectPath: 'C:\\Project-A' });
  assert.equal(terminalBelongsToProject(registered, 'C:/project-a'), true, 'separators + dir casing');
  assert.equal(terminalBelongsToProject(registered, 'c:\\PROJECT-A\\'), true, 'drive casing + trailing slash');
  assert.equal(terminalBelongsToProject(registered, 'C:/project-B'), false, 'a different project still differs');
  assert.equal(terminalBelongsToProject(registered, 'C:/project-A-other'), false, 'a name prefix is not a match');
});

test('terminalBelongsToProject scopes LEGACY (no projectPath) terminals by cwd', () => {
  // The bug: a persisted terminal from an older sessionStorage shape, missing
  // projectPath, whose cwd points at project A.
  const legacy = term({ id: 'legacy', cwd: `${PROJECT_A}/packages/api` });
  assert.equal(
    terminalBelongsToProject(legacy, PROJECT_A),
    true,
    'legacy terminal shows in the project its cwd lives under',
  );
  assert.equal(
    terminalBelongsToProject(legacy, PROJECT_B),
    false,
    'legacy terminal must NOT leak into an unrelated project',
  );
});

// ---- useTerminalGroups (listing) + Sidebar active-id reconciliation --------

// Mirror of Sidebar.tsx's reconciliation effect so the test asserts both that a
// legacy cross-project terminal is not *listed* and not *chosen* as active.
function Harness({
  terminals,
  folder,
  initialActiveId,
  report,
}: {
  terminals: TerminalSpec[];
  folder: string;
  initialActiveId: string | null;
  report: (r: { listed: string[]; activeId: string | null }) => void;
}) {
  const { projectTerminals } = useTerminalGroups(terminals, folder);
  const [activeId, setActiveId] = React.useState<string | null>(initialActiveId);

  React.useEffect(() => {
    if (!activeId) return;
    const current = projectTerminals.find((t) => t.id === activeId);
    if (current) return;
    if (projectTerminals.length > 0) {
      setActiveId(projectTerminals[projectTerminals.length - 1].id);
    } else {
      setActiveId(null);
    }
  }, [folder, projectTerminals, activeId]);

  report({ listed: projectTerminals.map((t) => t.id), activeId });
  return null;
}

test('a legacy terminal under project A is neither listed nor auto-selected under project B', () => {
  const restore = installGlobal('React', React);
  const restoreActEnv = installGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  // One legacy terminal (no projectPath) whose cwd is under project A, plus a
  // properly-tagged project-B terminal.
  const terminals: TerminalSpec[] = [
    term({ id: 'legacyA', cwd: `${PROJECT_A}/src` }),
    term({ id: 'tabB', cwd: PROJECT_B, projectPath: PROJECT_B }),
  ];

  let last: { listed: string[]; activeId: string | null } = { listed: [], activeId: null };
  const report = (r: { listed: string[]; activeId: string | null }) => {
    last = r;
  };

  let renderer!: ReturnType<typeof TestRenderer.create>;
  try {
    // Boot showing project B with the legacy terminal (mis)selected as active —
    // exactly the upgrade-from-old-sessionStorage scenario.
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(Harness, {
          terminals,
          folder: PROJECT_B,
          initialActiveId: 'legacyA',
          report,
        }),
      );
    });

    assert.deepEqual(
      last.listed,
      ['tabB'],
      'legacy project-A terminal must not appear in project B',
    );
    assert.equal(
      last.activeId,
      'tabB',
      'active selection falls to a real project-B terminal, not the legacy one',
    );

    // Switching to project A surfaces the legacy terminal (its cwd lives there).
    act(() => {
      renderer.update(
        React.createElement(Harness, {
          terminals,
          folder: PROJECT_A,
          initialActiveId: 'legacyA',
          report,
        }),
      );
    });
    assert.deepEqual(
      last.listed,
      ['legacyA'],
      'legacy terminal is scoped to the project its cwd descends from',
    );
    assert.equal(last.activeId, 'legacyA', 'and can be the active tab there');
  } finally {
    act(() => renderer.unmount());
    restoreActEnv();
    restore();
  }
});
