'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  pathsFor,
  pickResumeAt,
  latestContextTokens,
  sessionMovedOn,
  quoteArg,
  buildScript,
  buildLaunchArgs,
  RESET_GRACE_MS,
} = require('../../src/lib/resume');

const NOW = 1_800_000_000_000;
const IN_1H = NOW / 1000 + 3600; // seconds, like the status line stores them
const IN_3D = NOW / 1000 + 3 * 24 * 3600;

test('pathsFor names plan, script and task after the project', () => {
  const p = pathsFor('/home/me/app', '/state/resume');
  assert.match(p.slug, /^app-[0-9a-f]{8}$/);
  assert.equal(p.planPath, `/state/resume/${p.slug}.json`);
  assert.ok(p.scriptPath.startsWith(`/state/resume/${p.slug}.`));
  assert.equal(p.taskName, `resume-${p.slug}`);
  assert.equal(p.slug, pathsFor('/home/me/app').slug);
});

test('pickResumeAt', async (t) => {
  await t.test('is null without rate-limit data', () => {
    assert.equal(pickResumeAt([{ ts: NOW, contextUsedPct: 50 }], NOW), null);
  });

  await t.test('uses the 5h reset when only that limit is used up', () => {
    const history = [{ ts: NOW, fiveHourPct: 100, fiveHourResetsAt: IN_1H, sevenDayPct: 40, sevenDayResetsAt: IN_3D }];
    assert.equal(pickResumeAt(history, NOW), IN_1H * 1000 + RESET_GRACE_MS);
  });

  await t.test('waits for the 7-day reset when that limit is used up too', () => {
    const history = [{ ts: NOW, fiveHourPct: 100, fiveHourResetsAt: IN_1H, sevenDayPct: 100, sevenDayResetsAt: IN_3D }];
    assert.equal(pickResumeAt(history, NOW), IN_3D * 1000 + RESET_GRACE_MS);
  });

  await t.test('falls back to the 5h reset when no limit looks used up', () => {
    const history = [{ ts: NOW, fiveHourPct: 60, fiveHourResetsAt: IN_1H }];
    assert.equal(pickResumeAt(history, NOW), IN_1H * 1000 + RESET_GRACE_MS);
  });

  await t.test('ignores resets already in the past', () => {
    const history = [{ ts: NOW, fiveHourPct: 100, fiveHourResetsAt: NOW / 1000 - 10 }];
    assert.equal(pickResumeAt(history, NOW), null);
  });

  await t.test('reads the newest sample', () => {
    const history = [
      { ts: NOW, fiveHourPct: 100, fiveHourResetsAt: IN_1H },
      { ts: NOW - 5000, fiveHourPct: 100, fiveHourResetsAt: IN_1H - 999 },
    ];
    assert.equal(pickResumeAt(history, NOW), IN_1H * 1000 + RESET_GRACE_MS);
  });
});

test('sessionMovedOn ignores idle re-samples but notices new tokens', () => {
  const history = [
    { sessionId: 's1', ts: NOW - 1000, contextTokens: 5000 },
    { sessionId: 's2', ts: NOW + 1000, contextTokens: 9999 },
  ];
  assert.equal(latestContextTokens(history, 's1'), 5000);
  const plan = { sessionId: 's1', createdAt: NOW, contextTokens: 5000 };

  // The status line keeps sampling an idle session with the same count.
  const idle = history.concat([{ sessionId: 's1', ts: NOW + 60000, contextTokens: 5000 }]);
  assert.equal(sessionMovedOn(idle, plan), false);

  const resumed = idle.concat([{ sessionId: 's1', ts: NOW + 120000, contextTokens: 7000 }]);
  assert.equal(sessionMovedOn(resumed, plan), true);

  assert.equal(sessionMovedOn(resumed, { ...plan, contextTokens: null }), false);
});

test('quoteArg neutralises shell syntax per platform', () => {
  assert.equal(quoteArg('say "hi" 100% now!', 'win32'), '"say  hi  100  now "');
  assert.equal(quoteArg("it's here", 'linux'), "'it'\\''s here'");
});

test('buildScript resumes the session interactively from the project folder', () => {
  const plan = { cwd: 'C:\\work\\app', sessionId: 'abc-123', prompt: 'Carry on.' };

  const cmd = buildScript(plan, 'win32');
  assert.match(cmd, /^@echo off\r\n/);
  assert.match(cmd, /cd \/d "C:\\work\\app"\r\n/);
  assert.match(cmd, /claude --resume "abc-123" "Carry on\."/);

  const sh = buildScript({ ...plan, cwd: '/work/app' }, 'linux');
  assert.match(sh, /^#!\/bin\/sh\n/);
  assert.match(sh, /cd '\/work\/app' \|\| exit 1/);
  assert.match(sh, /exec claude --resume 'abc-123' 'Carry on\.'/);
});

test('buildLaunchArgs resumes in the background with the configured permission mode', () => {
  assert.deepEqual(buildLaunchArgs({ sessionId: 's1', permissionMode: 'acceptEdits', prompt: 'Go.' }), [
    '--bg',
    '--resume',
    's1',
    '--permission-mode',
    'acceptEdits',
    'Go.',
  ]);
});

test('pathsFor uses forward slashes', () => {
  const p = pathsFor('/home/me/app', path.join('C:', 'state'));
  assert.ok(!p.planPath.includes('\\'));
});
