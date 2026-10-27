'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  lastPathSegment,
  averageTurnDelta,
  detectRecentCompaction,
  formatAgo,
} = require('../src/index');

// ---------------------------------------------------------------------------
// Unit tests for the exported pure helpers.
// ---------------------------------------------------------------------------

test('lastPathSegment', async (t) => {
  await t.test('extracts the final segment from a posix path', () => {
    assert.equal(lastPathSegment('/home/user/project'), 'project');
  });

  await t.test('extracts the final segment from a windows path', () => {
    assert.equal(lastPathSegment('C:\\Users\\garci\\project'), 'project');
  });

  await t.test('drops a trailing slash instead of returning an empty segment', () => {
    assert.equal(lastPathSegment('/home/user/project/'), 'project');
  });

  await t.test('returns "" for empty/undefined/null input', () => {
    assert.equal(lastPathSegment(''), '');
    assert.equal(lastPathSegment(undefined), '');
    assert.equal(lastPathSegment(null), '');
  });

  await t.test('returns the input unchanged when it has no separators', () => {
    assert.equal(lastPathSegment('project'), 'project');
  });
});

test('averageTurnDelta', async (t) => {
  await t.test('returns null when the session has no history', () => {
    assert.equal(averageTurnDelta([], 's1'), null);
  });

  await t.test('returns null with only a single data point', () => {
    const history = [{ sessionId: 's1', ts: 1, contextTokens: 100 }];
    assert.equal(averageTurnDelta(history, 's1'), null);
  });

  await t.test('averages positive deltas between consecutive samples', () => {
    const history = [
      { sessionId: 's1', ts: 1, contextTokens: 100 },
      { sessionId: 's1', ts: 2, contextTokens: 200 },
      { sessionId: 's1', ts: 3, contextTokens: 260 },
    ];
    // deltas: 100, 60 -> average 80
    assert.equal(averageTurnDelta(history, 's1'), 80);
  });

  await t.test('excludes drops (compactions) from the average', () => {
    const history = [
      { sessionId: 's1', ts: 1, contextTokens: 100 },
      { sessionId: 's1', ts: 2, contextTokens: 200 }, // +100
      { sessionId: 's1', ts: 3, contextTokens: 10 }, // compaction, dropped
      { sessionId: 's1', ts: 4, contextTokens: 60 }, // +50
    ];
    assert.equal(averageTurnDelta(history, 's1'), 75);
  });

  await t.test('only considers the most recent 10 deltas', () => {
    const history = [];
    // deltas of 10 apiece for the first 5 turns, then 100 apiece for the next 10
    let tokens = 0;
    for (let i = 0; i < 5; i++) {
      tokens += 10;
      history.push({ sessionId: 's1', ts: history.length, contextTokens: tokens });
    }
    for (let i = 0; i < 10; i++) {
      tokens += 100;
      history.push({ sessionId: 's1', ts: history.length, contextTokens: tokens });
    }
    assert.equal(averageTurnDelta(history, 's1'), 100);
  });

  await t.test('ignores entries from other sessions', () => {
    const history = [
      { sessionId: 's1', ts: 1, contextTokens: 100 },
      { sessionId: 's2', ts: 2, contextTokens: 99999 },
      { sessionId: 's1', ts: 3, contextTokens: 150 },
    ];
    assert.equal(averageTurnDelta(history, 's1'), 50);
  });

  await t.test('ignores entries without a numeric contextTokens', () => {
    const history = [
      { sessionId: 's1', ts: 1, contextTokens: 100 },
      { sessionId: 's1', ts: 2 },
      { sessionId: 's1', ts: 3, contextTokens: 150 },
    ];
    assert.equal(averageTurnDelta(history, 's1'), 50);
  });
});

test('detectRecentCompaction', async (t) => {
  await t.test('returns null when contextWindowSize is unknown', () => {
    assert.equal(detectRecentCompaction([], 's1', null, Date.now()), null);
  });

  await t.test('returns null when there is no drop at all', () => {
    const history = [
      { sessionId: 's1', ts: 1, contextTokens: 100 },
      { sessionId: 's1', ts: 2, contextTokens: 200 },
    ];
    assert.equal(detectRecentCompaction(history, 's1', 200000, 2), null);
  });

  await t.test('ignores a drop smaller than 20% of the context window', () => {
    const history = [
      { sessionId: 's1', ts: 1, contextTokens: 50000, contextUsedPct: 25 },
      { sessionId: 's1', ts: 2, contextTokens: 40000, contextUsedPct: 20 }, // 5% drop only
    ];
    assert.equal(detectRecentCompaction(history, 's1', 200000, 2), null);
  });

  await t.test('detects a qualifying drop and flags it auto when prior usage was high', () => {
    const history = [
      { sessionId: 's1', ts: 1000, contextTokens: 190000, contextUsedPct: 95 },
      { sessionId: 's1', ts: 2000, contextTokens: 10000, contextUsedPct: 5 }, // 90% drop
    ];
    const result = detectRecentCompaction(history, 's1', 200000, 2000);
    assert.deepEqual(result, { ts: 2000, auto: true });
  });

  await t.test('flags a manual compaction (low prior usage) as not auto', () => {
    const history = [
      { sessionId: 's1', ts: 1000, contextTokens: 60000, contextUsedPct: 30 },
      { sessionId: 's1', ts: 2000, contextTokens: 5000, contextUsedPct: 2.5 }, // /clear-style manual reset
    ];
    const result = detectRecentCompaction(history, 's1', 200000, 2000);
    assert.deepEqual(result, { ts: 2000, auto: false });
  });

  await t.test('stops showing the compaction once COMPACTION_VISIBLE_MS has passed', () => {
    const history = [
      { sessionId: 's1', ts: 0, contextTokens: 190000, contextUsedPct: 95 },
      { sessionId: 's1', ts: 1000, contextTokens: 10000, contextUsedPct: 5 },
    ];
    const sixteenMinutesLater = 1000 + 16 * 60 * 1000;
    assert.equal(detectRecentCompaction(history, 's1', 200000, sixteenMinutesLater), null);
  });

  await t.test('picks the most recent qualifying drop when there are several', () => {
    const history = [
      { sessionId: 's1', ts: 0, contextTokens: 190000, contextUsedPct: 95 },
      { sessionId: 's1', ts: 1000, contextTokens: 10000, contextUsedPct: 5 }, // first compaction
      { sessionId: 's1', ts: 2000, contextTokens: 195000, contextUsedPct: 97.5 },
      { sessionId: 's1', ts: 3000, contextTokens: 8000, contextUsedPct: 4 }, // second, more recent compaction
    ];
    const result = detectRecentCompaction(history, 's1', 200000, 3000);
    assert.equal(result.ts, 3000);
  });

  await t.test('ignores entries from other sessions', () => {
    const history = [
      { sessionId: 's2', ts: 0, contextTokens: 190000, contextUsedPct: 95 },
      { sessionId: 's2', ts: 1000, contextTokens: 10000, contextUsedPct: 5 },
    ];
    assert.equal(detectRecentCompaction(history, 's1', 200000, 1000), null);
  });
});

test('formatAgo', async (t) => {
  await t.test('reports "just now" under one minute', () => {
    assert.equal(formatAgo(0), 'just now');
    assert.equal(formatAgo(59_999), 'just now');
  });

  await t.test('delegates to formatDuration at/after one minute', () => {
    assert.equal(formatAgo(60_000), '1m ago');
    assert.equal(formatAgo(60 * 60 * 1000 + 60_000), '1h1m ago');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: spawn the real CLI entry point against a temp state dir
// so the real ~/.claude/context-runway/usage-history.jsonl is never touched.
// ---------------------------------------------------------------------------

const INDEX_PATH = path.join(__dirname, '..', 'src', 'index.js');

function runStatusline({ input, stateDir }) {
  const dir = stateDir || fs.mkdtempSync(path.join(os.tmpdir(), 'context-runway-index-test-'));
  const result = spawnSync(process.execPath, [INDEX_PATH], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, CONTEXT_RUNWAY_STATE_DIR: dir },
    encoding: 'utf8',
  });
  if (!stateDir) fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

// Strips ANSI escape codes so assertions can match on plain text.
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

test('malformed stdin JSON produces the waiting message instead of crashing', () => {
  const result = runStatusline({ input: '{not valid json' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'context-runway: waiting for session data\n');
  assert.equal(result.stderr, '');
});

test('empty stdin produces the waiting message instead of crashing', () => {
  const result = runStatusline({ input: '' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'context-runway: waiting for session data\n');
});

test('a minimal payload with no context_window/rate_limits renders just the header', () => {
  const result = runStatusline({ input: { session_id: 'minimal-session' } });
  assert.equal(result.status, 0);
  const out = stripAnsi(result.stdout);
  assert.ok(out.includes('Claude'));
  const nonEmptyLines = out.split('\n').filter(Boolean);
  assert.equal(nonEmptyLines.length, 1, `expected only the header line, got:\n${out}`);
});

test('a full payload renders ctx/5h/7d rows', () => {
  const result = runStatusline({
    input: {
      model: { display_name: 'Sonnet' },
      workspace: { current_dir: '/home/user/myproj' },
      session_id: 'full-session',
      context_window: {
        used_percentage: 42,
        total_input_tokens: 80000,
        total_output_tokens: 4000,
        context_window_size: 200000,
      },
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        seven_day: { used_percentage: 41.2, resets_at: Math.floor(Date.now() / 1000) + 86400 },
      },
    },
  });
  assert.equal(result.status, 0);
  const out = stripAnsi(result.stdout);
  assert.ok(out.includes('myproj'));
  assert.ok(out.includes('ctx '));
  assert.ok(out.includes('5h '));
  assert.ok(out.includes('7d '));
  assert.ok(out.includes('42%'));
});

test('renders a loc row only once Claude Code sends cost data', () => {
  const withoutCost = runStatusline({
    input: { session_id: 'no-cost-session', context_window: { used_percentage: 10 } },
  });
  const outWithout = stripAnsi(withoutCost.stdout);
  assert.ok(!outWithout.includes('loc '), `expected no loc row in:\n${outWithout}`);

  const withCost = runStatusline({
    input: {
      session_id: 'cost-session',
      context_window: { used_percentage: 10 },
      cost: { total_lines_added: 128, total_lines_removed: 34 },
    },
  });
  const outWith = stripAnsi(withCost.stdout);
  assert.ok(outWith.includes('loc '), `expected a loc row in:\n${outWith}`);
  assert.ok(outWith.includes('+128/-34'));
});

test('truncates an overly long session name and only shows a label when another session is recent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-runway-index-test-'));
  try {
    const historyFile = path.join(dir, 'usage-history.jsonl');
    const otherSession = { ts: Date.now(), sessionId: 'other-session', dir: 'myproj', contextUsedPct: 10 };
    fs.writeFileSync(historyFile, JSON.stringify(otherSession) + '\n');

    const longName = 'x'.repeat(50);
    const result = runStatusline({
      stateDir: dir,
      input: {
        session_id: 'current-session',
        session_name: longName,
        workspace: { current_dir: '/home/user/myproj' },
      },
    });

    assert.equal(result.status, 0);
    const out = stripAnsi(result.stdout);
    assert.ok(!out.includes(longName), 'full 50-char name should have been truncated');
    assert.ok(out.includes('x'.repeat(39) + '…'), `expected truncated label in:\n${out}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('does not show a session label when no other session has been active recently', () => {
  const result = runStatusline({
    input: {
      session_id: 'solo-session',
      session_name: 'my-solo-chat',
      workspace: { current_dir: '/home/user/myproj' },
    },
  });
  const out = stripAnsi(result.stdout);
  assert.ok(!out.includes('my-solo-chat'));
});

test('detects and labels an auto-compaction end to end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-runway-index-test-'));
  try {
    const historyFile = path.join(dir, 'usage-history.jsonl');
    const before = {
      ts: Date.now() - 60_000,
      sessionId: 'compact-session',
      dir: 'myproj',
      contextTokens: 190000,
      contextUsedPct: 95,
      contextWindowSize: 200000,
    };
    fs.writeFileSync(historyFile, JSON.stringify(before) + '\n');

    const result = runStatusline({
      stateDir: dir,
      input: {
        session_id: 'compact-session',
        workspace: { current_dir: '/home/user/myproj' },
        context_window: {
          used_percentage: 5,
          total_input_tokens: 9000,
          total_output_tokens: 1000,
          context_window_size: 200000,
        },
      },
    });

    assert.equal(result.status, 0);
    const out = stripAnsi(result.stdout);
    assert.ok(out.includes('auto-compacted'), `expected auto-compacted in:\n${out}`);
    assert.ok(out.includes('context was reset'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('never writes to the real home-directory state dir when CONTEXT_RUNWAY_STATE_DIR is set', () => {
  // Sanity check on the test harness itself: run once, then confirm the
  // temp dir used actually received the write (proving isolation works and
  // nothing silently fell back to the real ~/.claude path).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-runway-index-test-'));
  try {
    runStatusline({ stateDir: dir, input: { session_id: 'isolation-check' } });
    const historyFile = path.join(dir, 'usage-history.jsonl');
    assert.ok(fs.existsSync(historyFile));
    const contents = fs.readFileSync(historyFile, 'utf8');
    assert.ok(contents.includes('isolation-check'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
