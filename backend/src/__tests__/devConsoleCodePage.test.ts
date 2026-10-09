// The dev console sink writes raw UTF-8 bytes to fd 1, which a Windows console
// decodes with its output code page — 437 on a US install — so every non-ASCII
// character in the dev console was mojibake (`·` in each `[mem]` line showed
// as `┬╖`). `useUtf8ConsoleCodePage` switches the console to 65001 for the dev
// loop's lifetime and must put the user's own code page back exactly once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useUtf8ConsoleCodePage } from '../../../scripts/orchestrate/consoleSink.mjs';

function fakeChcp(current: string | null) {
  const calls: string[][] = [];
  let page = current;
  const chcp = (args: string[]) => {
    calls.push(args);
    if (args.length > 0) page = args[0];
    return page === null ? null : `Active code page: ${page}\r\n`;
  };
  return { chcp, calls, page: () => page };
}

test('a Windows console is switched to UTF-8 and restored once', () => {
  const f = fakeChcp('437');
  const restore = useUtf8ConsoleCodePage({ platform: 'win32', isTTY: true, chcp: f.chcp });
  assert.equal(f.page(), '65001');
  restore();
  restore();
  assert.equal(f.page(), '437');
  assert.deepEqual(f.calls, [[], ['65001'], ['437']]);
});

test('a localized chcp line still yields the code page', () => {
  const calls: string[][] = [];
  const restore = useUtf8ConsoleCodePage({
    platform: 'win32', isTTY: true,
    chcp: (args) => { calls.push(args); return 'Aktive Codepage: 850.\r\n'; },
  });
  restore();
  assert.deepEqual(calls, [[], ['65001'], ['850']]);
});

for (const [name, deps, current] of [
  ['off Windows', { platform: 'linux', isTTY: true }, '437'],
  ['when stdout is not a console', { platform: 'win32', isTTY: false }, '437'],
] as const) {
  test(`nothing is run ${name}`, () => {
    const f = fakeChcp(current);
    useUtf8ConsoleCodePage({ ...deps, chcp: f.chcp })();
    assert.deepEqual(f.calls, []);
  });
}

for (const [name, current] of [['already UTF-8', '65001'], ['unreadable', null]] as const) {
  test(`a console whose code page is ${name} is left alone`, () => {
    const f = fakeChcp(current);
    useUtf8ConsoleCodePage({ platform: 'win32', isTTY: true, chcp: f.chcp })();
    assert.deepEqual(f.calls, [[]]);
  });
}
