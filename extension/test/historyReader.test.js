'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// STATE_DIR is read from CONTEXT_RUNWAY_STATE_DIR once at module-load time,
// so each filesystem test gets a throwaway temp dir and a fresh require
// (cache busted) to stay isolated from the user's real ~/.claude state.
function loadHistoryReader(stateDir) {
  const modPath = require.resolve('../src/historyReader');
  delete require.cache[modPath];
  if (stateDir) process.env.CONTEXT_RUNWAY_STATE_DIR = stateDir;
  return require(modPath);
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-runway-ext-history-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('readHistory returns [] when the history file does not exist', () => {
  withTempDir((dir) => {
    const { readHistory } = loadHistoryReader(dir);
    assert.deepEqual(readHistory(), []);
  });
});

test('readHistory skips malformed JSON lines but keeps valid ones', () => {
  withTempDir((dir) => {
    const { readHistory, HISTORY_FILE } = loadHistoryReader(dir);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [JSON.stringify({ ts: 1, sessionId: 'a' }), '{{{not json', JSON.stringify({ ts: 2, sessionId: 'b' })];
    fs.writeFileSync(HISTORY_FILE, lines.join('\n') + '\n');

    const result = readHistory();
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((e) => e.sessionId), ['a', 'b']);
  });
});

test('honors CONTEXT_RUNWAY_STATE_DIR rather than the real home directory', () => {
  withTempDir((dir) => {
    const { STATE_DIR, HISTORY_FILE } = loadHistoryReader(dir);
    assert.equal(STATE_DIR, dir);
    assert.equal(HISTORY_FILE, path.join(dir, 'usage-history.jsonl'));
  });
});

test('mostRecentWithField', async (t) => {
  const { mostRecentWithField } = loadHistoryReader();

  await t.test('returns null for an empty history', () => {
    assert.equal(mostRecentWithField([], 'fiveHourPct'), null);
  });

  await t.test('returns null when no entry has the field', () => {
    const history = [{ ts: 1 }, { ts: 2, otherField: 5 }];
    assert.equal(mostRecentWithField(history, 'fiveHourPct'), null);
  });

  await t.test('scans backward to find the most recent entry with the field set', () => {
    const history = [
      { ts: 1, fiveHourPct: 10 },
      { ts: 2 }, // newer entry from a brand-new session, missing the field
      { ts: 3 }, // same
    ];
    const result = mostRecentWithField(history, 'fiveHourPct');
    assert.equal(result.ts, 1);
  });

  await t.test('ignores non-numeric values for the field', () => {
    const history = [
      { ts: 1, fiveHourPct: 10 },
      { ts: 2, fiveHourPct: null },
      { ts: 3, fiveHourPct: 'not a number' },
    ];
    const result = mostRecentWithField(history, 'fiveHourPct');
    assert.equal(result.ts, 1);
  });
});

test('sessionLabel', async (t) => {
  const { sessionLabel } = loadHistoryReader();

  await t.test('prefers an explicit session name', () => {
    assert.equal(sessionLabel({ sessionName: 'my-chat', sessionId: 'abcdef123456', dir: 'proj' }), 'my-chat');
  });

  await t.test('falls back to dir + short session id', () => {
    assert.equal(sessionLabel({ sessionId: 'abcdef123456', dir: 'proj' }), 'proj · #abcdef');
  });

  await t.test('falls back to just the short session id when dir is missing', () => {
    assert.equal(sessionLabel({ sessionId: 'abcdef123456' }), '#abcdef');
  });

  await t.test('falls back to ?????? when sessionId is missing too', () => {
    assert.equal(sessionLabel({}), '#??????');
  });
});

test('formatTokenCount', async (t) => {
  const { formatTokenCount } = loadHistoryReader();

  await t.test('handles null, thousands, and millions', () => {
    assert.equal(formatTokenCount(null), null);
    assert.equal(formatTokenCount(999), '999');
    assert.equal(formatTokenCount(1000), '1K');
    assert.equal(formatTokenCount(1_000_000), '1M');
    assert.equal(formatTokenCount(1_500_000), '1.5M');
  });
});

test('formatAgo', async (t) => {
  const { formatAgo } = loadHistoryReader();

  await t.test('reports "just now" under one minute', () => {
    assert.equal(formatAgo(0), 'just now');
    assert.equal(formatAgo(59_999), 'just now');
  });

  await t.test('renders minutes/hours/days once a minute has passed', () => {
    assert.equal(formatAgo(60_000), '1m ago');
    assert.equal(formatAgo(60 * 60 * 1000 + 60_000), '1h1m ago');
    assert.equal(formatAgo(25 * 60 * 60 * 1000), '1d1h ago');
  });
});
